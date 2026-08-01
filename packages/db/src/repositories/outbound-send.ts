import { retryabilityForOutboundSendState, type DeliveryRetryability } from '../retryability'
import type { NewThread } from './mail-projection'

export type OutboundSendState = 'failed' | 'queued' | 'sending' | 'sent' | 'unknown'

export interface ReserveOutboundSendInput {
  actorUserId: string
  createdAt: number
  id: string
  idempotencyKey: string
  mailboxId: string
  newThread?: NewThread
  requestDigest: string
  threadId: string | null
}

export interface OutboundSendRecord {
  actorUserId: string
  attemptCount: number
  createdAt: number
  id: string
  idempotencyKey: string
  lastAttemptedAt: number | null
  mailboxId: string
  messageId: string | null
  providerErrorCode: string | null
  providerMessageId: string | null
  requestDigest: string
  retryability: DeliveryRetryability
  state: OutboundSendState
  threadId: string | null
  updatedAt: number
}

export type ReserveOutboundSendResult =
  | { kind: 'conflict' }
  | { kind: 'replay'; send: OutboundSendRecord }
  | { kind: 'reserved'; send: OutboundSendRecord }

export interface RecordOutboundAttemptInput {
  actorUserId: string
  id: string
  mailboxId: string
  messageId: string | null
  now: number
  providerErrorCode: string | null
  providerMessageId: string | null
  requestDigest: string
  state: 'failed' | 'unknown'
}

export interface ClaimQueuedSendInput {
  actorUserId: string
  id: string
  mailboxId: string
  now: number
  requestDigest: string
}

/** Internal send-idempotency repository; all actor reads are mailbox scoped. */
export class OutboundSendRepository {
  readonly #binding: D1Database

  constructor(binding: D1Database) {
    this.#binding = binding
  }

  async reserve(input: ReserveOutboundSendInput): Promise<ReserveOutboundSendResult> {
    assertUnixMilliseconds(input.createdAt)
    assertDigest(input.requestDigest)
    if (
      input.newThread !== undefined &&
      (input.newThread.id !== input.threadId || input.newThread.mailboxId !== input.mailboxId)
    ) {
      throw new TypeError('A reserved send must belong to its new thread.')
    }
    const statements: D1PreparedStatement[] = []
    if (input.newThread !== undefined) {
      const thread = input.newThread
      statements.push(
        this.#binding
          .prepare(`
            INSERT INTO threads (
              id, mailbox_id, subject, normalized_subject, workflow_state, archived_at,
              latest_message_id, last_message_at, last_message_preview,
              last_message_direction, last_sender_address, message_count, unread_count,
              created_at, updated_at
            )
            SELECT ?, ?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, 0, 0, ?, ?
            FROM mailbox_members
            WHERE mailbox_id = ? AND user_id = ?
              AND NOT EXISTS (
                SELECT 1 FROM outbound_sends WHERE idempotency_key = ?
              )
          `)
          .bind(
            thread.id,
            thread.mailboxId,
            thread.subject,
            thread.normalizedSubject,
            thread.workflowState,
            thread.archivedAt ?? null,
            thread.lastMessageAt,
            thread.createdAt,
            thread.updatedAt,
            input.mailboxId,
            input.actorUserId,
            input.idempotencyKey,
          ),
      )
    }
    statements.push(
      this.#binding
        .prepare(`
        INSERT INTO outbound_sends (
          id, idempotency_key, actor_user_id, mailbox_id, thread_id,
          request_digest, state, message_id, provider_message_id,
          provider_error_code, retryability, attempt_count, last_attempted_at,
          created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 'retryable', 0, NULL, ?, ?
        FROM mailbox_members
        WHERE mailbox_id = ? AND user_id = ?
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
        .bind(
          input.id,
          input.idempotencyKey,
          input.actorUserId,
          input.mailboxId,
          input.threadId,
          input.requestDigest,
          input.createdAt,
          input.createdAt,
          input.mailboxId,
          input.actorUserId,
        ),
    )
    const results = await this.#binding.batch(statements)
    const insert = results.at(-1)

    const send = await this.getByIdempotencyKey(
      input.idempotencyKey,
      input.actorUserId,
      input.mailboxId,
    )
    if (send === undefined || send.requestDigest !== input.requestDigest) {
      return { kind: 'conflict' }
    }
    return changed(insert) ? { kind: 'reserved', send } : { kind: 'replay', send }
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
    actorUserId: string,
    mailboxId: string,
  ): Promise<OutboundSendRecord | undefined> {
    const result = await this.#binding
      .prepare(`
        SELECT
          sends.id,
          sends.idempotency_key AS idempotencyKey,
          sends.actor_user_id AS actorUserId,
          sends.mailbox_id AS mailboxId,
          sends.thread_id AS threadId,
          sends.request_digest AS requestDigest,
          sends.state,
          sends.message_id AS messageId,
          sends.provider_message_id AS providerMessageId,
          sends.provider_error_code AS providerErrorCode,
          sends.retryability,
          sends.attempt_count AS attemptCount,
          sends.last_attempted_at AS lastAttemptedAt,
          sends.created_at AS createdAt,
          sends.updated_at AS updatedAt
        FROM outbound_sends AS sends
        INNER JOIN mailbox_members AS members
          ON members.mailbox_id = sends.mailbox_id
          AND members.user_id = sends.actor_user_id
        WHERE sends.idempotency_key = ?
          AND sends.actor_user_id = ?
          AND sends.mailbox_id = ?
        LIMIT 1
      `)
      .bind(idempotencyKey, actorUserId, mailboxId)
      .first<OutboundSendRecord>()
    return result ?? undefined
  }

  async claimQueuedSend(input: ClaimQueuedSendInput): Promise<boolean> {
    assertUnixMilliseconds(input.now)
    assertDigest(input.requestDigest)
    const result = await this.#binding
      .prepare(`
        UPDATE outbound_sends
        SET
          state = 'sending',
          retryability = 'manual_confirmation_required',
          attempt_count = attempt_count + CASE WHEN state = 'queued' THEN 1 ELSE 0 END,
          last_attempted_at = ?,
          updated_at = max(updated_at, ?)
        WHERE id = ?
          AND actor_user_id = ?
          AND mailbox_id = ?
          AND request_digest = ?
          AND state = 'queued'
          AND EXISTS (
            SELECT 1 FROM mailbox_members
            WHERE mailbox_members.mailbox_id = outbound_sends.mailbox_id
              AND mailbox_members.user_id = outbound_sends.actor_user_id
          )
      `)
      .bind(input.now, input.now, input.id, input.actorUserId, input.mailboxId, input.requestDigest)
      .run()
    return changed(result)
  }

  async recordAttempt(input: RecordOutboundAttemptInput): Promise<boolean> {
    assertUnixMilliseconds(input.now)
    assertDigest(input.requestDigest)
    const result = await this.#binding
      .prepare(`
        UPDATE outbound_sends
        SET
          state = ?,
          message_id = ?,
          provider_message_id = ?,
          provider_error_code = ?,
          retryability = ?,
          attempt_count = attempt_count + CASE WHEN state = 'queued' THEN 1 ELSE 0 END,
          last_attempted_at = ?,
          updated_at = max(updated_at, ?)
        WHERE id = ?
          AND actor_user_id = ?
          AND mailbox_id = ?
          AND request_digest = ?
          AND ((? = 'failed' AND state = 'queued') OR (? = 'unknown' AND state = 'sending'))
          AND EXISTS (
            SELECT 1 FROM mailbox_members
            WHERE mailbox_members.mailbox_id = outbound_sends.mailbox_id
              AND mailbox_members.user_id = outbound_sends.actor_user_id
          )
      `)
      .bind(
        input.state,
        input.messageId,
        input.providerMessageId,
        input.providerErrorCode,
        retryabilityForOutboundSendState(input.state),
        input.now,
        input.now,
        input.id,
        input.actorUserId,
        input.mailboxId,
        input.requestDigest,
        input.state,
        input.state,
      )
      .run()
    return changed(result)
  }
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Request digest must be a lower-case SHA-256 hex value.')
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
