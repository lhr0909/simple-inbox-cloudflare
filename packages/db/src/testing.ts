import { createInboxDatabase } from './database'
import { apiTokens, mailboxMembers, mailboxes, magicLinks, users } from './schema'

export interface SyntheticSeedUser {
  email: string
  id: string
}

export interface SyntheticSeedMailbox {
  address: string
  forwardTo: string | null
  id: string
  ownerUserId: string
  senderAlias: string | null
}

export interface SyntheticSeedMagicLink {
  expiresAt: number
  id: string
  requestedAt: number
  tokenDigest: string
  usedAt?: number | null
  userId: string
}

export interface SyntheticSeedApiToken {
  createdAt: number
  expiresAt?: number | null
  id: string
  name: string
  revokedAt?: number | null
  scopes: number
  tokenDigest: string
  userId: string
}

export interface SyntheticInboxSeed {
  apiTokens?: readonly SyntheticSeedApiToken[]
  magicLinks?: readonly SyntheticSeedMagicLink[]
  mailboxes: readonly SyntheticSeedMailbox[]
  now: number
  users: readonly SyntheticSeedUser[]
}

/**
 * Idempotently creates deterministic identities and credentials for local test
 * operators. This is intentionally exported only through `@cloudflare-inbox/db/testing`.
 */
export async function seedSyntheticInbox(
  binding: D1Database,
  input: SyntheticInboxSeed,
): Promise<void> {
  validateSeed(input)
  const db = createInboxDatabase(binding)

  if (input.users.length > 0) {
    await db
      .insert(users)
      .values(
        input.users.map((user) => ({
          createdAt: input.now,
          disabledAt: null,
          email: user.email,
          id: user.id,
        })),
      )
      .onConflictDoNothing()
  }

  if (input.mailboxes.length > 0) {
    await db
      .insert(mailboxes)
      .values(
        input.mailboxes.map((mailbox) => ({
          address: mailbox.address,
          createdAt: input.now,
          forwardTo: mailbox.forwardTo,
          id: mailbox.id,
          senderAlias: mailbox.senderAlias,
          updatedAt: input.now,
        })),
      )
      .onConflictDoNothing()
    await db
      .insert(mailboxMembers)
      .values(
        input.mailboxes.map((mailbox) => ({
          createdAt: input.now,
          mailboxId: mailbox.id,
          role: 'owner',
          userId: mailbox.ownerUserId,
        })),
      )
      .onConflictDoNothing()
  }

  if ((input.magicLinks?.length ?? 0) > 0) {
    await db
      .insert(magicLinks)
      .values(
        input.magicLinks!.map((link) => ({
          expiresAt: link.expiresAt,
          id: link.id,
          requestedAt: link.requestedAt,
          tokenDigest: link.tokenDigest,
          usedAt: link.usedAt ?? null,
          userId: link.userId,
        })),
      )
      .onConflictDoNothing()
  }

  if ((input.apiTokens?.length ?? 0) > 0) {
    await db
      .insert(apiTokens)
      .values(
        input.apiTokens!.map((token) => ({
          createdAt: token.createdAt,
          expiresAt: token.expiresAt ?? null,
          id: token.id,
          lastUsedAt: null,
          name: token.name,
          revokedAt: token.revokedAt ?? null,
          scopes: token.scopes,
          tokenDigest: token.tokenDigest,
          userId: token.userId,
        })),
      )
      .onConflictDoNothing()
  }
}

function validateSeed(input: SyntheticInboxSeed): void {
  assertTimestamp(input.now, 'Seed time')
  for (const link of input.magicLinks ?? []) {
    assertDigest(link.tokenDigest, 'Magic-link digest')
    assertTimestamp(link.requestedAt, 'Magic-link request time')
    assertTimestamp(link.expiresAt, 'Magic-link expiry')
    if (link.expiresAt <= link.requestedAt) {
      throw new RangeError('Magic-link expiry must be after its request time.')
    }
    if (link.usedAt !== undefined && link.usedAt !== null) {
      assertTimestamp(link.usedAt, 'Magic-link use time')
    }
  }
  for (const token of input.apiTokens ?? []) {
    assertDigest(token.tokenDigest, 'API-token digest')
    assertTimestamp(token.createdAt, 'API-token creation time')
    if (!Number.isSafeInteger(token.scopes) || token.scopes < 1 || token.scopes > 7) {
      throw new RangeError('API-token scopes must be an integer between 1 and 7.')
    }
  }
}

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a lower-case SHA-256 hex value.`)
  }
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative Unix millisecond integer.`)
  }
}
