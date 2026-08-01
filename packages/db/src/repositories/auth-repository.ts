import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm'

import { API_TOKEN_SCOPE, type ApiTokenScope } from '../auth'
import { createInboxDatabase, type InboxDatabase } from '../database'
import { apiTokens, sessions, users } from '../schema'

export interface CreateMagicLinkInput {
  cooldownMs: number
  expiresAt: number
  id: string
  normalizedEmail: string
  requestedAt: number
  tokenDigest: string
}

export interface ConsumeMagicLinkInput {
  consumedAt: number
  sessionExpiresAt: number
  sessionId: string
  sessionTokenDigest: string
  tokenDigest: string
}

export interface SessionPrincipal {
  email: string
  expiresAt: number
  sessionId: string
  userId: string
}

export interface ApiTokenPrincipal {
  email: string
  scopes: number
  tokenId: string
  userId: string
}

export interface BootstrapOwnerInput {
  mailboxAddress: string
  mailboxId: string
  now: number
  ownerEmail: string
  userId: string
}

export interface BootstrapOwnerResult {
  mailboxId: string
  userId: string
}

export class AuthRepository {
  readonly #binding: D1Database
  readonly #db: InboxDatabase

  constructor(binding: D1Database) {
    this.#binding = binding
    this.#db = createInboxDatabase(binding)
  }

  /**
   * The insert and exact cooldown check are one SQL statement. Callers should
   * still return the same external response regardless of the boolean result.
   */
  async tryCreateMagicLink(input: CreateMagicLinkInput): Promise<boolean> {
    assertNormalizedEmail(input.normalizedEmail)
    assertDigest(input.tokenDigest)
    assertUnixMilliseconds(input.requestedAt)
    assertUnixMilliseconds(input.expiresAt)
    if (input.expiresAt <= input.requestedAt) {
      throw new RangeError('Magic-link expiry must be after its request time.')
    }
    if (!Number.isSafeInteger(input.cooldownMs) || input.cooldownMs < 0) {
      throw new RangeError('Magic-link cooldown must be a non-negative integer.')
    }

    const cooldownBoundary = Math.max(0, input.requestedAt - input.cooldownMs)
    const result = await this.#binding
      .prepare(`
        INSERT INTO magic_links (id, user_id, token_digest, expires_at, used_at, requested_at)
        SELECT ?, users.id, ?, ?, NULL, ?
        FROM users
        WHERE users.email = ?
          AND users.disabled_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM magic_links AS recent
            WHERE recent.user_id = users.id AND recent.requested_at > ?
          )
      `)
      .bind(
        input.id,
        input.tokenDigest,
        input.expiresAt,
        input.requestedAt,
        input.normalizedEmail,
        cooldownBoundary,
      )
      .run()
    return changed(result)
  }

  /**
   * D1 batch is transactional. Inserting the session first makes the unique
   * source_magic_link_id constraint the race arbiter; the second statement
   * consumes only the link selected by that newly inserted session.
   */
  async consumeMagicLink(input: ConsumeMagicLinkInput): Promise<SessionPrincipal | undefined> {
    assertDigest(input.tokenDigest)
    assertDigest(input.sessionTokenDigest)
    assertUnixMilliseconds(input.consumedAt)
    assertUnixMilliseconds(input.sessionExpiresAt)
    if (input.sessionExpiresAt <= input.consumedAt) {
      throw new RangeError('Session expiry must be after session creation.')
    }

    const statements = [
      this.#binding
        .prepare(`
          INSERT INTO sessions (
            id, user_id, token_digest, source_magic_link_id,
            expires_at, revoked_at, last_seen_at, created_at
          )
          SELECT ?, links.user_id, ?, links.id, ?, NULL, ?, ?
          FROM magic_links AS links
          INNER JOIN users ON users.id = links.user_id
          WHERE links.token_digest = ?
            AND links.used_at IS NULL
            AND links.expires_at > ?
            AND users.disabled_at IS NULL
        `)
        .bind(
          input.sessionId,
          input.sessionTokenDigest,
          input.sessionExpiresAt,
          input.consumedAt,
          input.consumedAt,
          input.tokenDigest,
          input.consumedAt,
        ),
      this.#binding
        .prepare(`
          UPDATE magic_links
          SET used_at = ?
          WHERE token_digest = ?
            AND used_at IS NULL
            AND EXISTS (
              SELECT 1 FROM sessions
              WHERE sessions.id = ?
                AND sessions.source_magic_link_id = magic_links.id
            )
        `)
        .bind(input.consumedAt, input.tokenDigest, input.sessionId),
    ]

    const results = await this.#binding.batch(statements)
    if (!changed(results[0]) || !changed(results[1])) {
      return undefined
    }

    return this.findSession(input.sessionTokenDigest, input.consumedAt, 0)
  }

  async findSession(
    tokenDigest: string,
    now: number,
    lastSeenThrottleMs = 5 * 60 * 1000,
  ): Promise<SessionPrincipal | undefined> {
    assertDigest(tokenDigest)
    assertUnixMilliseconds(now)
    if (!Number.isSafeInteger(lastSeenThrottleMs) || lastSeenThrottleMs < 0) {
      throw new RangeError('Session touch throttle must be a non-negative integer.')
    }

    const [row] = await this.#db
      .select({
        email: users.email,
        expiresAt: sessions.expiresAt,
        lastSeenAt: sessions.lastSeenAt,
        sessionId: sessions.id,
        userId: sessions.userId,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenDigest, tokenDigest),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          isNull(users.disabledAt),
        ),
      )
      .limit(1)
    if (row === undefined) {
      return undefined
    }

    if (row.lastSeenAt <= now - lastSeenThrottleMs) {
      await this.#db
        .update(sessions)
        .set({ lastSeenAt: now })
        .where(
          and(
            eq(sessions.id, row.sessionId),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, now),
            lte(sessions.lastSeenAt, now - lastSeenThrottleMs),
          ),
        )
    }

    return {
      email: row.email,
      expiresAt: row.expiresAt,
      sessionId: row.sessionId,
      userId: row.userId,
    }
  }

  async revokeSession(tokenDigest: string, revokedAt: number): Promise<boolean> {
    assertDigest(tokenDigest)
    assertUnixMilliseconds(revokedAt)
    const result = await this.#db
      .update(sessions)
      .set({ revokedAt })
      .where(and(eq(sessions.tokenDigest, tokenDigest), isNull(sessions.revokedAt)))
    return changed(result)
  }

  async findApiToken(
    tokenDigest: string,
    requiredScope: ApiTokenScope,
    now: number,
    lastUsedThrottleMs = 5 * 60 * 1000,
  ): Promise<ApiTokenPrincipal | undefined> {
    assertDigest(tokenDigest)
    assertUnixMilliseconds(now)
    if (!Number.isSafeInteger(lastUsedThrottleMs) || lastUsedThrottleMs < 0) {
      throw new RangeError('API token touch throttle must be a non-negative integer.')
    }
    const requiredBit = API_TOKEN_SCOPE[requiredScope]

    const [row] = await this.#db
      .select({
        email: users.email,
        lastUsedAt: apiTokens.lastUsedAt,
        scopes: apiTokens.scopes,
        tokenId: apiTokens.id,
        userId: apiTokens.userId,
      })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(
        and(
          eq(apiTokens.tokenDigest, tokenDigest),
          isNull(apiTokens.revokedAt),
          sql`(${apiTokens.expiresAt} IS NULL OR ${apiTokens.expiresAt} > ${now})`,
          sql`(${apiTokens.scopes} & ${requiredBit}) = ${requiredBit}`,
          isNull(users.disabledAt),
        ),
      )
      .limit(1)
    if (row === undefined) {
      return undefined
    }

    if (row.lastUsedAt === null || row.lastUsedAt <= now - lastUsedThrottleMs) {
      await this.#db
        .update(apiTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(apiTokens.id, row.tokenId),
            isNull(apiTokens.revokedAt),
            sql`(${apiTokens.expiresAt} IS NULL OR ${apiTokens.expiresAt} > ${now})`,
            sql`(${apiTokens.lastUsedAt} IS NULL OR ${apiTokens.lastUsedAt} <= ${now - lastUsedThrottleMs})`,
          ),
        )
    }

    return { email: row.email, scopes: row.scopes, tokenId: row.tokenId, userId: row.userId }
  }

  async bootstrapOwner(input: BootstrapOwnerInput): Promise<BootstrapOwnerResult> {
    assertNormalizedEmail(input.ownerEmail)
    assertNormalizedEmail(input.mailboxAddress)
    assertUnixMilliseconds(input.now)

    const existing = await this.#binding
      .prepare(`
        SELECT
          mailboxes.id AS mailboxId,
          count(CASE WHEN mailbox_members.role = 'owner' THEN 1 END) AS ownerCount,
          max(CASE WHEN mailbox_members.role = 'owner' AND users.email = ? THEN users.id END) AS userId
        FROM mailboxes
        LEFT JOIN mailbox_members ON mailbox_members.mailbox_id = mailboxes.id
        LEFT JOIN users ON users.id = mailbox_members.user_id
        WHERE mailboxes.address = ?
        GROUP BY mailboxes.id
        LIMIT 1
      `)
      .bind(input.ownerEmail, input.mailboxAddress)
      .first<{ mailboxId: string; ownerCount: number; userId: string | null }>()
    if (existing !== null) {
      if (Number(existing.ownerCount) !== 1 || existing.userId === null) {
        throw new Error('Existing mailbox ownership does not match the configured owner.')
      }
      return { mailboxId: existing.mailboxId, userId: existing.userId }
    }

    const statements = [
      this.#binding
        .prepare(`
          INSERT INTO users (id, email, created_at, disabled_at)
          VALUES (?, ?, ?, NULL)
          ON CONFLICT(email) DO NOTHING
        `)
        .bind(input.userId, input.ownerEmail, input.now),
      this.#binding
        .prepare(`
          INSERT INTO mailboxes (id, address, sender_alias, forward_to, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?)
          ON CONFLICT(address) DO NOTHING
        `)
        .bind(input.mailboxId, input.mailboxAddress, input.ownerEmail, input.now, input.now),
      this.#binding
        .prepare(`
          INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
          SELECT mailboxes.id, users.id, 'owner', ?
          FROM users, mailboxes
          WHERE users.email = ? AND mailboxes.address = ?
            AND NOT EXISTS (
              SELECT 1
              FROM mailbox_members AS existing_owner
              WHERE existing_owner.mailbox_id = mailboxes.id
                AND existing_owner.role = 'owner'
                AND existing_owner.user_id <> users.id
            )
          ON CONFLICT(mailbox_id, user_id) DO NOTHING
        `)
        .bind(input.now, input.ownerEmail, input.mailboxAddress),
    ]
    await this.#binding.batch(statements)

    const result = await this.#binding
      .prepare(`
        SELECT
          mailboxes.id AS mailboxId,
          count(CASE WHEN mailbox_members.role = 'owner' THEN 1 END) AS ownerCount,
          max(CASE WHEN mailbox_members.role = 'owner' AND users.email = ? THEN users.id END) AS userId
        FROM mailboxes
        LEFT JOIN mailbox_members ON mailbox_members.mailbox_id = mailboxes.id
        LEFT JOIN users ON users.id = mailbox_members.user_id
        WHERE mailboxes.address = ?
        GROUP BY mailboxes.id
        LIMIT 1
      `)
      .bind(input.ownerEmail, input.mailboxAddress)
      .first<{ mailboxId: string; ownerCount: number; userId: string | null }>()
    if (result === null || Number(result.ownerCount) !== 1 || result.userId === null) {
      throw new Error('Owner bootstrap did not produce exactly one configured owner.')
    }
    return { mailboxId: result.mailboxId, userId: result.userId }
  }
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Credential digest must be a lower-case SHA-256 hex value.')
  }
}

function assertNormalizedEmail(value: string): void {
  if (
    value.length < 3 ||
    value.length > 320 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    !value.includes('@')
  ) {
    throw new TypeError('Email address must be normalized before persistence.')
  }
}

function assertUnixMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative Unix millisecond integer.')
  }
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
