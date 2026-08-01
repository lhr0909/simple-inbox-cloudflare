import { and, asc, eq, isNull } from 'drizzle-orm'

import { createInboxDatabase, type InboxDatabase } from '../database'
import { retryabilityForMessageState } from '../retryability'
import { messages, replyAliases, threads } from '../schema'

export type MessageDirection = 'inbound' | 'outbound'
export type HtmlPolicy = 'blocked' | 'none' | 'sanitized'
export type SendState = 'failed' | 'not_applicable' | 'queued' | 'sending' | 'sent' | 'unknown'
export type ForwardState = 'failed' | 'forwarded' | 'not_applicable' | 'pending' | 'unknown'

// Keep the persistence boundary fail-closed even if a future caller bypasses
// mail-core's renderer. This intentionally mirrors its 1.5 MB combined body
// budget without adding a forbidden db -> mail-core package dependency.
const MAX_D1_MESSAGE_BODY_PROJECTION_BYTES = 1_500_000
const UTF8_ENCODER = new TextEncoder()

export interface MessageProjection {
  createdAt: number
  direction: MessageDirection
  forwardAttemptedAt: number | null
  forwardState: ForwardState
  fromAddress: string
  fromName: string | null
  htmlBody: string | null
  htmlPolicy: HtmlPolicy
  id: string
  inReplyTo: string | null
  ingestDigest: string | null
  internetMessageId: string | null
  mailboxId: string
  preview: string
  providerErrorCode: string | null
  providerMessageId: string | null
  rawR2Key: string
  rawSha256: string
  rawSize: number
  readAt: number | null
  receivedAt: number | null
  sendAttemptedAt: number | null
  sendState: SendState
  sentAt: number
  subject: string
  textBody: string | null
  threadId: string
  updatedAt: number
}

export interface RecipientProjection {
  address: string
  displayName: string | null
  kind: 'bcc' | 'cc' | 'reply_to' | 'to'
  position: number
}

export interface ReferenceProjection {
  internetMessageId: string
  position: number
}

export interface AttachmentProjection {
  contentId: string | null
  createdAt: number
  displayFilename: string | null
  disposition: 'attachment' | 'inline' | 'unknown'
  id: string
  mediaType: string
  mimeOrdinal: number
  size: number
}

export interface InsertMessageProjectionInput {
  attachments: readonly AttachmentProjection[]
  message: MessageProjection
  recipients: readonly RecipientProjection[]
  references: readonly ReferenceProjection[]
  /** Normalized tag names, not IDs. Raw HTML is deliberately never indexed. */
  searchTags?: readonly string[]
}

export interface CompleteOutboundProjectionInput {
  actorUserId: string
  now: number
  outboundSendId: string
  projection: InsertMessageProjectionInput
  requestDigest: string
}

export interface InsertInboundProjectionInput {
  newThread?: NewThread
  projection: InsertMessageProjectionInput
}

export interface NewThread {
  archivedAt?: number | null
  createdAt: number
  id: string
  lastMessageAt: number
  mailboxId: string
  normalizedSubject: string
  subject: string
  updatedAt: number
  workflowState: 'needs_reply' | 'resolved' | 'waiting'
}

export interface ResolvedReplyAlias {
  mailboxId: string
  relayDestination: string
  targetMessageId: string | null
  threadId: string
}

/**
 * Privileged repository for the mail Worker. It is intentionally separate
 * from MailboxScopedRepository: these methods process trusted internal email
 * events and must never be mounted directly on a browser-facing route.
 */
export class MailProjectionRepository {
  readonly #binding: D1Database
  readonly #db: InboxDatabase

  constructor(binding: D1Database) {
    this.#binding = binding
    this.#db = createInboxDatabase(binding)
  }

  async insertThread(input: NewThread): Promise<void> {
    await this.#db.insert(threads).values({
      archivedAt: input.archivedAt ?? null,
      createdAt: input.createdAt,
      id: input.id,
      lastMessageAt: input.lastMessageAt,
      lastMessageDirection: null,
      lastMessagePreview: '',
      lastSenderAddress: null,
      mailboxId: input.mailboxId,
      messageCount: 0,
      normalizedSubject: input.normalizedSubject,
      subject: input.subject,
      unreadCount: 0,
      updatedAt: input.updatedAt,
      workflowState: input.workflowState,
    })
  }

  async insertInboundProjection(input: InsertInboundProjectionInput): Promise<void> {
    if (input.projection.message.direction !== 'inbound') {
      throw new TypeError('Inbound completion requires an inbound projection.')
    }
    if (
      input.newThread !== undefined &&
      (input.newThread.id !== input.projection.message.threadId ||
        input.newThread.mailboxId !== input.projection.message.mailboxId)
    ) {
      throw new TypeError('A new inbound thread must own the projected message.')
    }

    const statements = [
      ...(input.newThread === undefined ? [] : [this.#prepareThreadInsert(input.newThread)]),
      ...this.#prepareMessageProjectionStatements(input.projection),
    ]
    const aggregateIndex = statements.length - 2
    const searchIndex = statements.length - 1
    const message = input.projection.message
    statements.push(
      this.#binding
        .prepare(`
          UPDATE threads
          SET
            archived_at = NULL,
            workflow_state = 'needs_reply',
            updated_at = max(updated_at, ?)
          WHERE id = ? AND mailbox_id = ?
        `)
        .bind(message.updatedAt, message.threadId, message.mailboxId),
    )

    const results = await this.#binding.batch(statements)
    if (
      !changed(results[aggregateIndex]) ||
      !changed(results[searchIndex]) ||
      !changed(results.at(-1))
    ) {
      throw new Error('Atomic inbound projection did not update every required record.')
    }
  }

  #prepareThreadInsert(input: NewThread): D1PreparedStatement {
    return this.#binding
      .prepare(`
        INSERT INTO threads (
          id, mailbox_id, subject, normalized_subject, workflow_state, archived_at,
          latest_message_id, last_message_at, last_message_preview,
          last_message_direction, last_sender_address, message_count, unread_count,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, 0, 0, ?, ?)
      `)
      .bind(
        input.id,
        input.mailboxId,
        input.subject,
        input.normalizedSubject,
        input.workflowState,
        input.archivedAt ?? null,
        input.lastMessageAt,
        input.createdAt,
        input.updatedAt,
      )
  }

  /**
   * Inserts normalized message state, ordered children, aggregate counters,
   * and the denormalized FTS document in one rollback-on-error D1 batch.
   */
  async insertMessageProjection(input: InsertMessageProjectionInput): Promise<void> {
    const statements = this.#prepareMessageProjectionStatements(input)
    const results = await this.#binding.batch(statements)
    const aggregateResult = results.at(-2)
    const searchResult = results.at(-1)
    if (!changed(aggregateResult) || !changed(searchResult)) {
      // Foreign keys normally make this unreachable. Surface it loudly if a
      // future migration weakens those constraints.
      throw new Error('Message projection did not update its thread and search aggregates.')
    }
  }

  #prepareMessageProjectionStatements(input: InsertMessageProjectionInput): D1PreparedStatement[] {
    validateProjection(input)
    const message = input.message
    const retryability =
      message.direction === 'inbound'
        ? retryabilityForMessageState({
            direction: 'inbound',
            forwardState: message.forwardState,
            sendState: 'not_applicable',
          })
        : retryabilityForMessageState({
            direction: 'outbound',
            forwardState: 'not_applicable',
            sendState: message.sendState,
          })
    const participants = normalizeSearchDocument([
      message.fromAddress,
      ...input.recipients.map((recipient) => recipient.address),
    ])
    const tags = normalizeSearchDocument(input.searchTags ?? [])
    const body = message.textBody ?? ''
    const statements: D1PreparedStatement[] = [
      this.#binding
        .prepare(`
          INSERT INTO messages (
            id, mailbox_id, thread_id, direction, ingest_digest,
            internet_message_id, provider_message_id, in_reply_to,
            from_address, from_name, subject, preview, text_body, html_body,
            html_policy, sent_at, received_at, raw_r2_key, raw_size, raw_sha256,
            read_at, send_state, forward_state, provider_error_code, retryability,
            send_attempted_at, forward_attempted_at, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?, ?
          )
        `)
        .bind(
          message.id,
          message.mailboxId,
          message.threadId,
          message.direction,
          message.ingestDigest,
          message.internetMessageId,
          message.providerMessageId,
          message.inReplyTo,
          message.fromAddress,
          message.fromName,
          message.subject,
          message.preview,
          message.textBody,
          message.htmlBody,
          message.htmlPolicy,
          message.sentAt,
          message.receivedAt,
          message.rawR2Key,
          message.rawSize,
          message.rawSha256,
          message.readAt,
          message.sendState,
          message.forwardState,
          message.providerErrorCode,
          retryability,
          message.sendAttemptedAt,
          message.forwardAttemptedAt,
          message.createdAt,
          message.updatedAt,
        ),
    ]

    for (const recipients of chunks(input.recipients, 20)) {
      const values = recipients.flatMap((recipient) => [
        message.id,
        recipient.kind,
        recipient.position,
        recipient.address,
        recipient.displayName,
      ])
      statements.push(
        this.#binding
          .prepare(`
            INSERT INTO message_recipients (
              message_id, kind, position, address, display_name
            ) VALUES ${recipients.map(() => '(?, ?, ?, ?, ?)').join(', ')}
          `)
          .bind(...values),
      )
    }

    for (const references of chunks(input.references, 33)) {
      const values = references.flatMap((reference) => [
        message.id,
        reference.position,
        reference.internetMessageId,
      ])
      statements.push(
        this.#binding
          .prepare(`
            INSERT INTO message_references (message_id, position, internet_message_id)
            VALUES ${references.map(() => '(?, ?, ?)').join(', ')}
          `)
          .bind(...values),
      )
    }

    for (const attachments of chunks(input.attachments, 11)) {
      const values = attachments.flatMap((attachment) => [
        attachment.id,
        message.id,
        attachment.mimeOrdinal,
        attachment.displayFilename,
        attachment.mediaType,
        attachment.size,
        attachment.disposition,
        attachment.contentId,
        attachment.createdAt,
      ])
      statements.push(
        this.#binding
          .prepare(`
            INSERT INTO attachments (
              id, message_id, mime_ordinal, display_filename, media_type,
              size, disposition, content_id, created_at
            ) VALUES ${attachments.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
          `)
          .bind(...values),
      )
    }

    statements.push(
      this.#binding
        .prepare(`
          UPDATE threads
          SET
            latest_message_id = CASE
              WHEN message_count = 0
                OR last_message_at < ?
                OR (last_message_at = ? AND coalesce(latest_message_id, '') < ?)
              THEN ? ELSE latest_message_id END,
            last_message_at = CASE
              WHEN message_count = 0
                OR last_message_at < ?
                OR (last_message_at = ? AND coalesce(latest_message_id, '') < ?)
              THEN ? ELSE last_message_at END,
            last_message_preview = CASE
              WHEN message_count = 0
                OR last_message_at < ?
                OR (last_message_at = ? AND coalesce(latest_message_id, '') < ?)
              THEN ? ELSE last_message_preview END,
            last_message_direction = CASE
              WHEN message_count = 0
                OR last_message_at < ?
                OR (last_message_at = ? AND coalesce(latest_message_id, '') < ?)
              THEN ? ELSE last_message_direction END,
            last_sender_address = CASE
              WHEN message_count = 0
                OR last_message_at < ?
                OR (last_message_at = ? AND coalesce(latest_message_id, '') < ?)
              THEN ? ELSE last_sender_address END,
            message_count = message_count + 1,
            unread_count = unread_count + ?,
            updated_at = max(updated_at, ?)
          WHERE id = ? AND mailbox_id = ?
        `)
        .bind(
          message.sentAt,
          message.sentAt,
          message.id,
          message.id,
          message.sentAt,
          message.sentAt,
          message.id,
          message.sentAt,
          message.sentAt,
          message.sentAt,
          message.id,
          message.preview,
          message.sentAt,
          message.sentAt,
          message.id,
          message.direction,
          message.sentAt,
          message.sentAt,
          message.id,
          message.fromAddress,
          message.direction === 'inbound' && message.readAt === null ? 1 : 0,
          message.updatedAt,
          message.threadId,
          message.mailboxId,
        ),
      this.#binding
        .prepare(`
          INSERT INTO message_search (
            message_id, thread_id, mailbox_id, subject,
            participants, body, tags, workflow_state
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, threads.workflow_state
          FROM threads
          WHERE threads.id = ? AND threads.mailbox_id = ?
        `)
        .bind(
          message.id,
          message.threadId,
          message.mailboxId,
          message.subject,
          participants,
          body,
          tags,
          message.threadId,
          message.mailboxId,
        ),
    )

    return statements
  }

  /**
   * Atomically projects the provider result, advances the thread workflow,
   * and finalizes the already-claimed outbound send. The leading guard turns
   * a lost/mismatched claim into a constraint error so the entire D1 batch
   * rolls back instead of committing a message without its idempotency record.
   */
  async completeOutboundProjection(input: CompleteOutboundProjectionInput): Promise<void> {
    assertUnixMilliseconds(input.now)
    assertDigest(input.requestDigest)
    const message = input.projection.message
    if (
      message.direction !== 'outbound' ||
      (message.sendState !== 'sent' && message.sendState !== 'unknown')
    ) {
      throw new TypeError('Outbound completion requires a sent or unknown outbound projection.')
    }

    const projectionStatements = this.#prepareMessageProjectionStatements(input.projection)
    const statements: D1PreparedStatement[] = [
      this.#binding
        .prepare(`
          INSERT INTO message_references (message_id, position, internet_message_id)
          SELECT ?, -1, '<outbound-delivery-claim-guard.invalid>'
          WHERE NOT EXISTS (
            SELECT 1
            FROM outbound_sends AS sends
            INNER JOIN mailbox_members AS members
              ON members.mailbox_id = sends.mailbox_id
              AND members.user_id = sends.actor_user_id
            WHERE sends.id = ?
              AND sends.actor_user_id = ?
              AND sends.mailbox_id = ?
              AND sends.thread_id = ?
              AND sends.request_digest = ?
              AND sends.state = 'sending'
          )
        `)
        .bind(
          message.id,
          input.outboundSendId,
          input.actorUserId,
          message.mailboxId,
          message.threadId,
          input.requestDigest,
        ),
      ...projectionStatements,
      this.#binding
        .prepare(`
          UPDATE messages
          SET read_at = ?, updated_at = max(updated_at, ?)
          WHERE mailbox_id = ?
            AND thread_id = ?
            AND direction = 'inbound'
            AND read_at IS NULL
        `)
        .bind(input.now, input.now, message.mailboxId, message.threadId),
      this.#binding
        .prepare(`
          UPDATE threads
          SET unread_count = 0, workflow_state = 'waiting', updated_at = max(updated_at, ?)
          WHERE id = ? AND mailbox_id = ?
        `)
        .bind(input.now, message.threadId, message.mailboxId),
      this.#binding
        .prepare(`
          UPDATE outbound_sends
          SET
            state = ?,
            message_id = ?,
            provider_message_id = ?,
            provider_error_code = ?,
            retryability = ?,
            updated_at = max(updated_at, ?)
          WHERE id = ?
            AND actor_user_id = ?
            AND mailbox_id = ?
            AND thread_id = ?
            AND request_digest = ?
            AND state = 'sending'
        `)
        .bind(
          message.sendState,
          message.id,
          message.providerMessageId,
          message.providerErrorCode,
          retryabilityForMessageState({
            direction: 'outbound',
            forwardState: 'not_applicable',
            sendState: message.sendState,
          }),
          input.now,
          input.outboundSendId,
          input.actorUserId,
          message.mailboxId,
          message.threadId,
          input.requestDigest,
        ),
    ]

    const results = await this.#binding.batch(statements)
    const aggregateResult = results.at(-5)
    const searchResult = results.at(-4)
    const workflowResult = results.at(-2)
    const sendResult = results.at(-1)
    if (
      !changed(aggregateResult) ||
      !changed(searchResult) ||
      !changed(workflowResult) ||
      !changed(sendResult)
    ) {
      throw new Error('Atomic outbound completion did not update every required record.')
    }
  }

  async replaceThreadTags(
    mailboxId: string,
    threadId: string,
    tagIds: readonly string[],
    normalizedTagNames: readonly string[],
    now: number,
  ): Promise<void> {
    assertUnixMilliseconds(now)
    const statements: D1PreparedStatement[] = [
      this.#binding
        .prepare('DELETE FROM thread_tags WHERE thread_id = ? AND mailbox_id = ?')
        .bind(threadId, mailboxId),
    ]
    for (const tagId of new Set(tagIds)) {
      statements.push(
        this.#binding
          .prepare(`
            INSERT INTO thread_tags (thread_id, tag_id, mailbox_id, created_at)
            SELECT ?, tags.id, ?, ?
            FROM tags
            WHERE tags.id = ? AND tags.mailbox_id = ?
          `)
          .bind(threadId, mailboxId, now, tagId, mailboxId),
      )
    }
    statements.push(
      this.#binding
        .prepare(`
          UPDATE message_search
          SET tags = ?
          WHERE thread_id = ? AND mailbox_id = ?
        `)
        .bind(normalizeSearchDocument(normalizedTagNames), threadId, mailboxId),
    )
    await this.#binding.batch(statements)
  }

  async findThreadByInternetMessageIds(
    mailboxId: string,
    internetMessageIds: readonly string[],
  ): Promise<string | undefined> {
    const candidates = [...new Set(internetMessageIds)].slice(0, 100)
    for (const internetMessageId of candidates) {
      const [match] = await this.#db
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(
          and(eq(messages.mailboxId, mailboxId), eq(messages.internetMessageId, internetMessageId)),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(1)
      if (match !== undefined) {
        return match.threadId
      }
    }
    return undefined
  }

  async resolveReplyAlias(localPart: string): Promise<ResolvedReplyAlias | undefined> {
    const [row] = await this.#db
      .select({
        mailboxId: replyAliases.mailboxId,
        relayDestination: replyAliases.relayDestination,
        targetMessageId: replyAliases.targetMessageId,
        threadId: replyAliases.threadId,
      })
      .from(replyAliases)
      .where(and(eq(replyAliases.localPart, localPart), isNull(replyAliases.revokedAt)))
      .limit(1)
    return row
  }
}

function validateProjection(input: InsertMessageProjectionInput): void {
  const message = input.message
  assertUnixMilliseconds(message.createdAt)
  assertUnixMilliseconds(message.sentAt)
  assertUnixMilliseconds(message.updatedAt)
  if (message.direction === 'inbound' && message.receivedAt === null) {
    throw new TypeError('Inbound message projections require a received timestamp.')
  }
  if (message.direction === 'outbound' && message.readAt !== null) {
    throw new TypeError('Outbound message projections do not carry read state.')
  }
  if ((message.textBody?.length ?? 0) > 1_000_000) {
    throw new TypeError('Projected plain-text bodies may contain at most 1,000,000 characters.')
  }
  if ((message.htmlBody?.length ?? 0) > 2_000_000) {
    throw new TypeError('Projected HTML bodies may contain at most 2,000,000 characters.')
  }
  const projectedBodyBytes =
    UTF8_ENCODER.encode(message.textBody ?? '').byteLength +
    UTF8_ENCODER.encode(message.htmlBody ?? '').byteLength
  if (projectedBodyBytes > MAX_D1_MESSAGE_BODY_PROJECTION_BYTES) {
    throw new TypeError(
      'Projected plain-text and HTML bodies may contain at most 1,500,000 UTF-8 bytes combined.',
    )
  }
  if (input.recipients.length > 200) {
    throw new TypeError('Message projections may contain at most 200 recipients.')
  }
  if (input.references.length > 100) {
    throw new TypeError('Message projections may contain at most 100 references.')
  }
  if (input.attachments.length > 100) {
    throw new TypeError('Message projections may contain at most 100 attachments.')
  }
  if (
    new Set(input.recipients.map(({ kind, position }) => `${kind}:${position}`)).size !==
    input.recipients.length
  ) {
    throw new TypeError('Recipient positions must be unique within each recipient kind.')
  }
  if (new Set(input.references.map(({ position }) => position)).size !== input.references.length) {
    throw new TypeError('Reference positions must be unique.')
  }
  if (
    new Set(input.attachments.map(({ mimeOrdinal }) => mimeOrdinal)).size !==
    input.attachments.length
  ) {
    throw new TypeError('Attachment MIME ordinals must be unique.')
  }
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const output: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size))
  }
  return output
}

function normalizeSearchDocument(values: readonly string[]): string {
  return [
    ...new Set(values.map((value) => value.normalize('NFKC').trim().toLocaleLowerCase('en-US'))),
  ]
    .filter((value) => value.length > 0)
    .join(' ')
    .slice(0, 16_384)
}

function assertUnixMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative Unix millisecond integer.')
  }
}

function assertDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('Request digest must be a lower-case SHA-256 hex value.')
  }
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
