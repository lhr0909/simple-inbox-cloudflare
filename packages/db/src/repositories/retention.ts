export const MAX_RETENTION_BATCH_SIZE = 100
export const MAX_RETENTION_DAYS = 3_650
export const MIN_RETENTION_DAYS = 1

const MILLISECONDS_PER_DAY = 86_400_000
const MAX_CLAIM_LEASE_MS = 3_600_000

export type RetentionState = 'application_pending' | 'completed' | 'raw_pending'

export interface RetentionTombstoneRecord {
  applicationDeleteAfter: number
  applicationDeletedAt: number | null
  attemptCount: number
  claimExpiresAt: number | null
  claimToken: string | null
  claimedAt: number | null
  completedAt: number | null
  createdAt: number
  id: string
  lastErrorCode: string | null
  lastFailedAt: number | null
  mailboxId: string
  messageId: string
  messageCreatedAt: number
  rawDeleteAfter: number
  rawDeletedAt: number | null
  rawR2Key: string
  state: RetentionState
  threadId: string
  updatedAt: number
}

export interface EnqueueRetentionInput {
  applicationRetentionDays: number
  limit: number
  now: number
  rawRetentionDays: number
}

export interface ClaimRetentionInput {
  claimToken: string
  leaseMs: number
  limit: number
  now: number
}

export interface RetentionClaim extends RetentionTombstoneRecord {
  claimExpiresAt: number
  claimToken: string
  claimedAt: number
  state: 'application_pending' | 'raw_pending'
}

/**
 * Privileged retention repository for scheduled mail-Worker jobs.
 *
 * The workflow is deliberately one-way and never calls outbound-send code:
 * `raw_pending` -> R2 delete -> `application_pending` -> D1 cleanup -> `completed`.
 * Completed tombstones retain only opaque IDs, timestamps, the object key, and
 * safe failure codes. Outbound send rows are detached, never deleted, so an
 * `unknown` delivery remains visible and its idempotency key cannot resend.
 */
export class RetentionRepository {
  readonly #binding: D1Database

  constructor(binding: D1Database) {
    this.#binding = binding
  }

  /**
   * Snapshots policy for a bounded set of raw-eligible messages. Eligibility
   * uses the trusted local `messages.created_at`, never a sender-controlled
   * RFC 822 Date header. A shared, content-addressed R2 object is not enqueued
   * until every live message that
   * references it is eligible, preventing one delivery from deleting bytes
   * still retained for another delivery.
   */
  async enqueueEligible(input: EnqueueRetentionInput): Promise<number> {
    validatePolicy(input.rawRetentionDays, input.applicationRetentionDays)
    assertUnixMilliseconds(input.now)
    assertBatchLimit(input.limit)
    const rawDuration = input.rawRetentionDays * MILLISECONDS_PER_DAY
    const applicationDuration = input.applicationRetentionDays * MILLISECONDS_PER_DAY
    const rawCutoff = input.now - rawDuration
    if (rawCutoff < 0) return 0

    const result = await this.#binding
      .prepare(`
        INSERT INTO retention_tombstones (
          id, message_id, mailbox_id, thread_id, raw_r2_key,
          message_created_at, raw_delete_after, application_delete_after,
          state, attempt_count, claim_token, claimed_at, claim_expires_at,
          raw_deleted_at, application_deleted_at, last_error_code,
          last_failed_at, created_at, updated_at, completed_at
        )
        SELECT
          candidate.id,
          candidate.id,
          candidate.mailbox_id,
          candidate.thread_id,
          candidate.raw_r2_key,
          candidate.created_at,
          candidate.created_at + ?,
          candidate.created_at + ?,
          'raw_pending',
          0,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          ?,
          ?,
          NULL
        FROM messages AS candidate
        WHERE candidate.created_at <= ?
          AND candidate.raw_deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM messages AS shared
            WHERE shared.raw_r2_key = candidate.raw_r2_key
              AND shared.raw_deleted_at IS NULL
              AND shared.created_at > ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM retention_tombstones AS existing
            WHERE existing.message_id = candidate.id
          )
        ORDER BY candidate.created_at, candidate.id
        LIMIT ?
        ON CONFLICT(message_id) DO NOTHING
      `)
      .bind(
        rawDuration,
        applicationDuration,
        input.now,
        input.now,
        rawCutoff,
        rawCutoff,
        input.limit,
      )
      .run()
    return changes(result)
  }

  async claimEligible(input: ClaimRetentionInput): Promise<RetentionClaim[]> {
    assertUnixMilliseconds(input.now)
    assertBatchLimit(input.limit)
    assertClaimToken(input.claimToken)
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1 ||
      input.leaseMs > MAX_CLAIM_LEASE_MS
    ) {
      throw new RangeError(`Claim lease must be between 1 and ${MAX_CLAIM_LEASE_MS} milliseconds.`)
    }
    const expiresAt = input.now + input.leaseMs
    assertUnixMilliseconds(expiresAt)

    await this.#binding
      .prepare(`
        UPDATE retention_tombstones
        SET
          claim_token = ?,
          claimed_at = ?,
          claim_expires_at = ?,
          attempt_count = attempt_count + 1,
          updated_at = max(updated_at, ?)
        WHERE id IN (
          SELECT candidate.id
          FROM retention_tombstones AS candidate
          WHERE candidate.state IN ('raw_pending', 'application_pending')
            AND (
              (candidate.state = 'raw_pending' AND candidate.raw_delete_after <= ?)
              OR (
                candidate.state = 'application_pending'
                AND candidate.application_delete_after <= ?
              )
            )
            AND (candidate.claim_token IS NULL OR candidate.claim_expires_at <= ?)
            AND (
              candidate.state = 'application_pending'
              OR NOT EXISTS (
                SELECT 1
                FROM messages AS shared
                WHERE shared.raw_r2_key = candidate.raw_r2_key
                  AND shared.raw_deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM retention_tombstones AS shared_tombstone
                    WHERE shared_tombstone.message_id = shared.id
                  )
              )
            )
          ORDER BY
            CASE candidate.state WHEN 'application_pending' THEN 0 ELSE 1 END,
            CASE candidate.state
              WHEN 'application_pending' THEN candidate.application_delete_after
              ELSE candidate.raw_delete_after
            END,
            candidate.id
          LIMIT ?
        )
      `)
      .bind(
        input.claimToken,
        input.now,
        expiresAt,
        input.now,
        input.now,
        input.now,
        input.now,
        input.limit,
      )
      .run()

    const result = await this.#binding
      .prepare(`${TOMBSTONE_SELECT}
        WHERE claim_token = ? AND claimed_at = ?
        ORDER BY
          CASE state WHEN 'application_pending' THEN 0 ELSE 1 END,
          CASE state
            WHEN 'application_pending' THEN application_delete_after
            ELSE raw_delete_after
          END,
          id
        LIMIT ?
      `)
      .bind(input.claimToken, input.now, input.limit)
      .all<RetentionTombstoneRecord>()
    return result.results.map(toClaim)
  }

  /** Called only after R2.delete() succeeds; deleting a missing key is success. */
  async markRawDeleted(input: {
    id: string
    keepClaim: boolean
    now: number
    token: string
  }): Promise<boolean> {
    assertUnixMilliseconds(input.now)
    assertClaimToken(input.token)
    const claimToken = input.keepClaim ? input.token : null
    const statements = [
      this.#binding
        .prepare(`
          UPDATE messages
          SET raw_deleted_at = coalesce(raw_deleted_at, ?), updated_at = max(updated_at, ?)
          WHERE id = (
            SELECT message_id FROM retention_tombstones
            WHERE id = ? AND claim_token = ? AND state = 'raw_pending'
          )
        `)
        .bind(input.now, input.now, input.id, input.token),
      this.#binding
        .prepare(`
          UPDATE retention_tombstones
          SET
            state = 'application_pending',
            raw_deleted_at = coalesce(raw_deleted_at, ?),
            claim_token = ?,
            claimed_at = CASE WHEN ? IS NULL THEN NULL ELSE claimed_at END,
            claim_expires_at = CASE WHEN ? IS NULL THEN NULL ELSE claim_expires_at END,
            updated_at = max(updated_at, ?)
          WHERE id = ? AND claim_token = ? AND state = 'raw_pending'
        `)
        .bind(input.now, claimToken, claimToken, claimToken, input.now, input.id, input.token),
    ]
    const results = await this.#binding.batch(statements)
    return changes(results.at(-1)) > 0
  }

  async recordFailure(input: {
    errorCode: string
    id: string
    now: number
    token: string
  }): Promise<boolean> {
    assertUnixMilliseconds(input.now)
    assertClaimToken(input.token)
    assertErrorCode(input.errorCode)
    const result = await this.#binding
      .prepare(`
        UPDATE retention_tombstones
        SET
          last_error_code = ?,
          last_failed_at = ?,
          claim_token = NULL,
          claimed_at = NULL,
          claim_expires_at = NULL,
          updated_at = max(updated_at, ?)
        WHERE id = ?
          AND claim_token = ?
          AND state IN ('raw_pending', 'application_pending')
      `)
      .bind(input.errorCode, input.now, input.now, input.id, input.token)
      .run()
    return changes(result) > 0
  }

  /**
   * Deletes normalized children/message state and repairs the containing thread
   * in one D1 transaction. If the thread becomes empty, send evidence is first
   * detached and the thread is removed. All statements are guarded by the same
   * claim token, making an expired/stolen claim a no-op.
   */
  async completeApplicationDeletion(input: {
    id: string
    mailboxId: string
    messageId: string
    now: number
    threadId: string
    token: string
  }): Promise<boolean> {
    assertUnixMilliseconds(input.now)
    assertClaimToken(input.token)
    const guard = `
      EXISTS (
        SELECT 1 FROM retention_tombstones AS claimed
        WHERE claimed.id = ?
          AND claimed.message_id = ?
          AND claimed.mailbox_id = ?
          AND claimed.thread_id = ?
          AND claimed.claim_token = ?
          AND claimed.state = 'application_pending'
      )
    `
    const guardValues = [
      input.id,
      input.messageId,
      input.mailboxId,
      input.threadId,
      input.token,
    ] as const
    const guarded = (query: string, ...prefix: unknown[]) =>
      this.#binding.prepare(query.replace('CLAIM_GUARD', guard)).bind(...prefix, ...guardValues)

    const statements: D1PreparedStatement[] = [
      guarded(
        `UPDATE outbound_sends
         SET message_id = NULL, updated_at = max(updated_at, ?)
         WHERE message_id = ? AND mailbox_id = ? AND CLAIM_GUARD`,
        input.now,
        input.messageId,
        input.mailboxId,
      ),
      guarded(
        `UPDATE reply_aliases
         SET target_message_id = NULL
         WHERE target_message_id = ? AND mailbox_id = ? AND CLAIM_GUARD`,
        input.messageId,
        input.mailboxId,
      ),
      guarded(
        'DELETE FROM message_recipients WHERE message_id = ? AND CLAIM_GUARD',
        input.messageId,
      ),
      guarded(
        'DELETE FROM message_references WHERE message_id = ? AND CLAIM_GUARD',
        input.messageId,
      ),
      guarded('DELETE FROM attachments WHERE message_id = ? AND CLAIM_GUARD', input.messageId),
      guarded('DELETE FROM message_search WHERE message_id = ? AND CLAIM_GUARD', input.messageId),
      guarded(
        `UPDATE threads
         SET latest_message_id = NULL, updated_at = max(updated_at, ?)
         WHERE id = ? AND mailbox_id = ? AND latest_message_id = ? AND CLAIM_GUARD`,
        input.now,
        input.threadId,
        input.mailboxId,
        input.messageId,
      ),
      guarded(
        'DELETE FROM messages WHERE id = ? AND mailbox_id = ? AND CLAIM_GUARD',
        input.messageId,
        input.mailboxId,
      ),
      guarded(
        `UPDATE threads
         SET
           latest_message_id = (
             SELECT remaining.id FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
             ORDER BY remaining.sent_at DESC, remaining.id DESC LIMIT 1
           ),
           last_message_at = (
             SELECT remaining.sent_at FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
             ORDER BY remaining.sent_at DESC, remaining.id DESC LIMIT 1
           ),
           last_message_preview = (
             SELECT remaining.preview FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
             ORDER BY remaining.sent_at DESC, remaining.id DESC LIMIT 1
           ),
           last_message_direction = (
             SELECT remaining.direction FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
             ORDER BY remaining.sent_at DESC, remaining.id DESC LIMIT 1
           ),
           last_sender_address = (
             SELECT remaining.from_address FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
             ORDER BY remaining.sent_at DESC, remaining.id DESC LIMIT 1
           ),
           message_count = (
             SELECT count(*) FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
           ),
           unread_count = (
             SELECT count(*) FROM messages AS remaining
             WHERE remaining.thread_id = threads.id
               AND remaining.mailbox_id = threads.mailbox_id
               AND remaining.direction = 'inbound'
               AND remaining.read_at IS NULL
           ),
           updated_at = max(updated_at, ?)
         WHERE id = ? AND mailbox_id = ?
           AND EXISTS (
             SELECT 1 FROM messages AS remaining
             WHERE remaining.thread_id = threads.id AND remaining.mailbox_id = threads.mailbox_id
           )
           AND CLAIM_GUARD`,
        input.now,
        input.threadId,
        input.mailboxId,
      ),
      guarded(
        `UPDATE outbound_sends
         SET thread_id = NULL, updated_at = max(updated_at, ?)
         WHERE thread_id = ? AND mailbox_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages AS remaining
             WHERE remaining.thread_id = ? AND remaining.mailbox_id = ?
           )
           AND CLAIM_GUARD`,
        input.now,
        input.threadId,
        input.mailboxId,
        input.threadId,
        input.mailboxId,
      ),
      guarded(
        `DELETE FROM threads
         WHERE id = ? AND mailbox_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM messages AS remaining
             WHERE remaining.thread_id = ? AND remaining.mailbox_id = ?
           )
           AND CLAIM_GUARD`,
        input.threadId,
        input.mailboxId,
        input.threadId,
        input.mailboxId,
      ),
      this.#binding
        .prepare(`
          UPDATE retention_tombstones
          SET
            state = 'completed',
            application_deleted_at = ?,
            completed_at = ?,
            claim_token = NULL,
            claimed_at = NULL,
            claim_expires_at = NULL,
            updated_at = max(updated_at, ?)
          WHERE id = ?
            AND message_id = ?
            AND mailbox_id = ?
            AND thread_id = ?
            AND claim_token = ?
            AND state = 'application_pending'
        `)
        .bind(
          input.now,
          input.now,
          input.now,
          input.id,
          input.messageId,
          input.mailboxId,
          input.threadId,
          input.token,
        ),
    ]

    const results = await this.#binding.batch(statements)
    return changes(results.at(-1)) > 0
  }

  async getById(id: string): Promise<RetentionTombstoneRecord | undefined> {
    const row = await this.#binding
      .prepare(`${TOMBSTONE_SELECT} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<RetentionTombstoneRecord>()
    return row ?? undefined
  }
}

const TOMBSTONE_SELECT = `
  SELECT
    id,
    message_id AS messageId,
    mailbox_id AS mailboxId,
    thread_id AS threadId,
    raw_r2_key AS rawR2Key,
    message_created_at AS messageCreatedAt,
    raw_delete_after AS rawDeleteAfter,
    application_delete_after AS applicationDeleteAfter,
    state,
    attempt_count AS attemptCount,
    claim_token AS claimToken,
    claimed_at AS claimedAt,
    claim_expires_at AS claimExpiresAt,
    raw_deleted_at AS rawDeletedAt,
    application_deleted_at AS applicationDeletedAt,
    last_error_code AS lastErrorCode,
    last_failed_at AS lastFailedAt,
    created_at AS createdAt,
    updated_at AS updatedAt,
    completed_at AS completedAt
  FROM retention_tombstones
`

function toClaim(row: RetentionTombstoneRecord): RetentionClaim {
  if (
    row.state === 'completed' ||
    row.claimToken === null ||
    row.claimedAt === null ||
    row.claimExpiresAt === null
  ) {
    throw new Error('Retention claim query returned an invalid tombstone state.')
  }
  return {
    ...row,
    claimExpiresAt: row.claimExpiresAt,
    claimToken: row.claimToken,
    claimedAt: row.claimedAt,
    state: row.state,
  }
}

function validatePolicy(rawDays: number, applicationDays: number): void {
  assertRetentionDays(rawDays, 'Raw-email')
  assertRetentionDays(applicationDays, 'Application-record')
  if (applicationDays < rawDays) {
    throw new RangeError('Application-record retention must be at least raw-email retention.')
  }
}

function assertRetentionDays(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    throw new RangeError(
      `${label} retention must be an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS} days.`,
    )
  }
}

function assertBatchLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RETENTION_BATCH_SIZE) {
    throw new RangeError(`Retention batch size must be between 1 and ${MAX_RETENTION_BATCH_SIZE}.`)
  }
}

function assertUnixMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative Unix millisecond integer.')
  }
}

function assertClaimToken(value: string): void {
  if (value.length < 16 || value.length > 128 || /[\r\n]/u.test(value)) {
    throw new TypeError('Retention claim token must be a bounded opaque value.')
  }
}

function assertErrorCode(value: string): void {
  if (!/^[a-z0-9_]{1,128}$/u.test(value)) {
    throw new TypeError('Retention error code must be a safe lower-case identifier.')
  }
}

function changes(result: D1Result<unknown> | undefined): number {
  return result?.meta.changes ?? 0
}
