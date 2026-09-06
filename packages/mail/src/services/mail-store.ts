import {
  AuthRepository,
  MailProjectionRepository,
  OutboundSendRepository,
  attachments,
  createInboxDatabase,
  mailboxMembers,
  mailboxes,
  messageRecipients,
  messageReferences,
  messages,
  outboundSends,
  retryabilityForMessageState,
  replyAliases,
  threads,
  users,
  type ClaimQueuedSendInput,
  type CompleteOutboundProjectionInput,
  type InboxDatabase,
  type InsertInboundProjectionInput,
  type OutboundSendRecord,
  type RecordOutboundAttemptInput,
  type ReserveOutboundSendInput,
  type ReserveOutboundSendResult,
} from '@cloudflare-inbox/db'
import {
  parseMailbox,
  parseReplyAlias,
  type SubjectThreadCandidate,
} from '@cloudflare-inbox/mail-core'
import { and, asc, desc, eq, gte, isNull, lte, or } from 'drizzle-orm'

import type {
  MailStore,
  MailboxRecord,
  InboundForwardContext,
  OutboundContext,
  ReplyAliasRecord,
  ReplyContextMessage,
} from '../types'

type MailboxJoinRow = {
  address: string
  forwardTo: string | null
  id: string
  ownerUserId: string
  senderAlias: string | null
}

/**
 * Worker-facing persistence orchestration.
 *
 * Message projection, auth bootstrap, and send idempotency remain owned by the
 * shared DB package. The small queries here assemble mail-delivery context from
 * exported schema objects so Worker handlers never contain SQL.
 */
export class D1MailStore implements MailStore {
  readonly #auth: AuthRepository
  readonly #db: InboxDatabase
  readonly #outbound: OutboundSendRepository
  readonly #projection: MailProjectionRepository

  constructor(binding: D1Database) {
    this.#auth = new AuthRepository(binding)
    this.#db = createInboxDatabase(binding)
    this.#outbound = new OutboundSendRepository(binding)
    this.#projection = new MailProjectionRepository(binding)
  }

  async ensureMailbox(input: {
    mailboxAddress: string
    mailboxId: string
    now: number
    ownerEmail: string
    userId: string
  }): Promise<MailboxRecord> {
    await this.#auth.bootstrapOwner(input)
    const row = await this.#findOwnedMailboxByAddress(input.mailboxAddress, input.ownerEmail)
    if (row === undefined) throw new Error('Mailbox bootstrap did not produce an owner membership.')
    return mailboxRecord(row)
  }

  async findInboundByDigest(
    ingestDigest: string,
  ): Promise<{ messageId: string; rawR2Key: string; threadId: string } | undefined> {
    const [row] = await this.#db
      .select({ messageId: messages.id, rawR2Key: messages.rawR2Key, threadId: messages.threadId })
      .from(messages)
      .where(and(eq(messages.direction, 'inbound'), eq(messages.ingestDigest, ingestDigest)))
      .limit(1)
    return row
  }

  async hasRawProjection(input: {
    direction: 'inbound' | 'outbound'
    mailboxId: string
    rawSha256: string
  }): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.direction, input.direction),
          eq(messages.rawSha256, input.rawSha256),
        ),
      )
      .limit(1)
    return row !== undefined
  }

  async projectInboundMessage(input: InsertInboundProjectionInput): Promise<void> {
    await this.#projection.insertInboundProjection(input)
  }

  async completeOutboundProjection(input: CompleteOutboundProjectionInput): Promise<void> {
    await this.#projection.completeOutboundProjection(input)
  }

  async findThreadByMessageIds(
    mailboxId: string,
    messageIds: readonly string[],
  ): Promise<string | undefined> {
    for (const messageId of [...new Set(messageIds)].slice(0, 100)) {
      const [row] = await this.#db
        .select({ threadId: messages.threadId })
        .from(messages)
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            or(
              eq(messages.internetMessageId, messageId),
              eq(messages.providerMessageId, messageId),
            ),
          ),
        )
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(1)
      if (row !== undefined) return row.threadId
    }
    return undefined
  }

  async listSubjectThreadCandidates(input: {
    mailboxId: string
    normalizedSubject: string
    receivedAt: number
    windowMs: number
  }): Promise<SubjectThreadCandidate[]> {
    const lowerBound = Math.max(0, input.receivedAt - input.windowMs)
    const rows = await this.#db
      .select({
        id: threads.id,
        lastMessageAt: threads.lastMessageAt,
        subject: threads.subject,
      })
      .from(threads)
      .where(
        and(
          eq(threads.mailboxId, input.mailboxId),
          eq(threads.normalizedSubject, input.normalizedSubject),
          gte(threads.lastMessageAt, lowerBound),
          lte(threads.lastMessageAt, input.receivedAt),
        ),
      )
      .orderBy(desc(threads.lastMessageAt), asc(threads.id))
      .limit(20)
    const candidates: SubjectThreadCandidate[] = []
    for (const row of rows) {
      const [messageRows, recipientRows] = await Promise.all([
        this.#db
          .select({ address: messages.fromAddress })
          .from(messages)
          .where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.threadId, row.id)))
          .limit(100),
        this.#db
          .select({ address: messageRecipients.address })
          .from(messageRecipients)
          .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
          .where(and(eq(messages.mailboxId, input.mailboxId), eq(messages.threadId, row.id)))
          .limit(100),
      ])
      const participants = [
        ...new Set([...messageRows, ...recipientRows].map(({ address }) => address)),
      ]
        .sort()
        .slice(0, 100)
      candidates.push({
        latestMessageAt: row.lastMessageAt,
        mailboxId: input.mailboxId,
        participants,
        subject: row.subject,
        threadId: row.id,
      })
    }
    return candidates
  }

  async ensureReplyAlias(input: {
    aliasId: string
    localPart: string
    mailboxId: string
    now: number
    relayDestination: string
    targetMessageId: string
    threadId: string
  }): Promise<ReplyAliasRecord | undefined> {
    const existing = await this.#findReplyAliasForMessage(input)
    if (existing !== undefined) return existing
    await this.#db
      .insert(replyAliases)
      .values({
        createdAt: input.now,
        id: input.aliasId,
        localPart: input.localPart,
        mailboxId: input.mailboxId,
        relayDestination: input.relayDestination,
        revokedAt: null,
        targetMessageId: input.targetMessageId,
        threadId: input.threadId,
      })
      .onConflictDoNothing()
      .run()
    return this.#findReplyAliasForMessage(input)
  }

  async resolveReplyAlias(address: string): Promise<ReplyAliasRecord | undefined> {
    const candidate = parseMailbox(address)
    const parsedAlias = parseReplyAlias(candidate.address, { domain: candidate.domain })
    if (parsedAlias === null) return undefined
    const resolved = await this.#projection.resolveReplyAlias(parsedAlias.token)
    if (resolved === undefined) return undefined
    const mailbox = await this.#findOwnedMailboxById(resolved.mailboxId)
    return mailbox === undefined || parseMailbox(mailbox.address).domain !== candidate.domain
      ? undefined
      : { ...resolved, localPart: parsedAlias.token, ownerUserId: mailbox.ownerUserId }
  }

  async listAllowedRelayDestinations(mailboxId: string, threadId: string): Promise<string[]> {
    const [messageRows, recipientRows] = await Promise.all([
      this.#db
        .select({ address: messages.fromAddress })
        .from(messages)
        .where(and(eq(messages.mailboxId, mailboxId), eq(messages.threadId, threadId)))
        .limit(100),
      this.#db
        .select({ address: messageRecipients.address })
        .from(messageRecipients)
        .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
        .where(
          and(
            eq(messages.mailboxId, mailboxId),
            eq(messages.threadId, threadId),
            or(
              eq(messageRecipients.kind, 'to'),
              eq(messageRecipients.kind, 'cc'),
              eq(messageRecipients.kind, 'reply_to'),
            ),
          ),
        )
        .limit(100),
    ])
    return [...new Set([...messageRows, ...recipientRows].map(({ address }) => address))]
      .sort()
      .slice(0, 100)
  }

  async claimPendingForward(input: { messageId: string; now: number }): Promise<boolean> {
    const result = await this.#db
      .update(messages)
      .set({
        forwardAttemptedAt: input.now,
        forwardState: 'unknown',
        providerErrorCode: 'owner_forward_claimed',
        retryability: 'manual_confirmation_required',
        updatedAt: input.now,
      })
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.direction, 'inbound'),
          eq(messages.forwardState, 'pending'),
          isNull(messages.forwardAttemptedAt),
        ),
      )
      .run()
    return (result.meta.changes ?? 0) > 0
  }

  async updateForwardResult(input: {
    messageId: string
    now: number
    providerErrorCode: string | null
    providerMessageId: string | null
    state: 'failed' | 'forwarded' | 'unknown'
  }): Promise<void> {
    const [existing] = await this.#db
      .select({ providerMessageId: messages.providerMessageId })
      .from(messages)
      .where(and(eq(messages.id, input.messageId), eq(messages.direction, 'inbound')))
      .limit(1)
    if (existing === undefined) throw new Error('Forward-state update did not find its message.')
    const result = await this.#db
      .update(messages)
      .set({
        forwardAttemptedAt: input.now,
        forwardState: input.state,
        providerErrorCode: input.providerErrorCode,
        providerMessageId: input.providerMessageId ?? existing.providerMessageId,
        retryability: retryabilityForMessageState({
          direction: 'inbound',
          forwardState: input.state,
          sendState: 'not_applicable',
        }),
        updatedAt: input.now,
      })
      .where(and(eq(messages.id, input.messageId), eq(messages.direction, 'inbound')))
      .run()
    requireChange(result, 'Forward-state update did not find its message.')
  }

  async getOutboundContext(input: {
    actorUserId: string
    mailboxId: string
    threadId?: string
  }): Promise<OutboundContext | undefined> {
    const [mailbox] = await this.#db
      .select({
        address: mailboxes.address,
        forwardTo: mailboxes.forwardTo,
        id: mailboxes.id,
        ownerUserId: users.id,
        senderAlias: mailboxes.senderAlias,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, mailboxes.id),
          eq(mailboxMembers.userId, input.actorUserId),
        ),
      )
      .innerJoin(users, eq(users.id, mailboxMembers.userId))
      .where(and(eq(mailboxes.id, input.mailboxId), isNull(users.disabledAt)))
      .limit(1)
    if (mailbox === undefined) return undefined

    let thread: OutboundContext['thread']
    if (input.threadId !== undefined) {
      const [row] = await this.#db
        .select({ archivedAt: threads.archivedAt, id: threads.id, subject: threads.subject })
        .from(threads)
        .where(and(eq(threads.id, input.threadId), eq(threads.mailboxId, input.mailboxId)))
        .limit(1)
      if (row === undefined) return undefined
      thread = row
    }
    const contextMessages =
      input.threadId === undefined
        ? []
        : await this.#listReplyContextMessages(input.mailboxId, input.threadId)
    return { mailbox: mailboxRecord(mailbox), messages: contextMessages, thread }
  }

  async getInboundForwardContext(messageId: string): Promise<InboundForwardContext | undefined> {
    const [message] = await this.#db
      .select({
        forwardState: messages.forwardState,
        mailboxId: messages.mailboxId,
        messageId: messages.id,
        receivedAt: messages.receivedAt,
        threadId: messages.threadId,
      })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.direction, 'inbound')))
      .limit(1)
    if (message === undefined || message.receivedAt === null) return undefined

    const [mailbox, attachmentRows] = await Promise.all([
      this.#findOwnedMailboxById(message.mailboxId),
      this.#db
        .select({ id: attachments.id, mimeOrdinal: attachments.mimeOrdinal })
        .from(attachments)
        .where(eq(attachments.messageId, messageId))
        .orderBy(asc(attachments.mimeOrdinal)),
    ])
    if (mailbox === undefined) return undefined
    return {
      attachments: attachmentRows,
      forwardState: message.forwardState as InboundForwardContext['forwardState'],
      mailbox: mailboxRecord(mailbox),
      messageId: message.messageId,
      receivedAt: message.receivedAt,
      threadId: message.threadId,
    }
  }

  async reserveOutboundSend(input: ReserveOutboundSendInput): Promise<ReserveOutboundSendResult> {
    return this.#outbound.reserve(input)
  }

  async claimQueuedSend(input: ClaimQueuedSendInput): Promise<boolean> {
    return this.#outbound.claimQueuedSend(input)
  }

  async recordOutboundAttempt(input: RecordOutboundAttemptInput): Promise<void> {
    if (!(await this.#outbound.recordAttempt(input))) {
      throw new Error('Outbound-send transition did not find its reserved record.')
    }
  }

  async findSendByIdempotencyKey(idempotencyKey: string): Promise<OutboundSendRecord | undefined> {
    const [row] = await this.#db
      .select({
        actorUserId: outboundSends.actorUserId,
        attemptCount: outboundSends.attemptCount,
        createdAt: outboundSends.createdAt,
        id: outboundSends.id,
        idempotencyKey: outboundSends.idempotencyKey,
        lastAttemptedAt: outboundSends.lastAttemptedAt,
        mailboxId: outboundSends.mailboxId,
        messageId: outboundSends.messageId,
        providerErrorCode: outboundSends.providerErrorCode,
        providerMessageId: outboundSends.providerMessageId,
        requestDigest: outboundSends.requestDigest,
        retryability: outboundSends.retryability,
        state: outboundSends.state,
        threadId: outboundSends.threadId,
        updatedAt: outboundSends.updatedAt,
      })
      .from(outboundSends)
      .where(eq(outboundSends.idempotencyKey, idempotencyKey))
      .limit(1)
    return row as OutboundSendRecord | undefined
  }

  async #findOwnedMailboxByAddress(
    address: string,
    ownerEmail: string,
  ): Promise<MailboxJoinRow | undefined> {
    const [row] = await this.#db
      .select({
        address: mailboxes.address,
        forwardTo: mailboxes.forwardTo,
        id: mailboxes.id,
        ownerUserId: users.id,
        senderAlias: mailboxes.senderAlias,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxMembers,
        and(eq(mailboxMembers.mailboxId, mailboxes.id), eq(mailboxMembers.role, 'owner')),
      )
      .innerJoin(users, eq(users.id, mailboxMembers.userId))
      .where(
        and(eq(mailboxes.address, address), eq(users.email, ownerEmail), isNull(users.disabledAt)),
      )
      .limit(1)
    return row
  }

  async #findOwnedMailboxById(mailboxId: string): Promise<MailboxJoinRow | undefined> {
    const [row] = await this.#db
      .select({
        address: mailboxes.address,
        forwardTo: mailboxes.forwardTo,
        id: mailboxes.id,
        ownerUserId: users.id,
        senderAlias: mailboxes.senderAlias,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxMembers,
        and(eq(mailboxMembers.mailboxId, mailboxes.id), eq(mailboxMembers.role, 'owner')),
      )
      .innerJoin(users, eq(users.id, mailboxMembers.userId))
      .where(and(eq(mailboxes.id, mailboxId), isNull(users.disabledAt)))
      .orderBy(asc(users.id))
      .limit(1)
    return row
  }

  async #findReplyAliasForMessage(input: {
    mailboxId: string
    relayDestination: string
    targetMessageId: string
    threadId: string
  }): Promise<ReplyAliasRecord | undefined> {
    const [row] = await this.#db
      .select({
        localPart: replyAliases.localPart,
        mailboxId: replyAliases.mailboxId,
        ownerUserId: users.id,
        relayDestination: replyAliases.relayDestination,
        targetMessageId: replyAliases.targetMessageId,
        threadId: replyAliases.threadId,
      })
      .from(replyAliases)
      .innerJoin(
        mailboxMembers,
        and(eq(mailboxMembers.mailboxId, replyAliases.mailboxId), eq(mailboxMembers.role, 'owner')),
      )
      .innerJoin(users, eq(users.id, mailboxMembers.userId))
      .where(
        and(
          eq(replyAliases.mailboxId, input.mailboxId),
          eq(replyAliases.threadId, input.threadId),
          eq(replyAliases.targetMessageId, input.targetMessageId),
          eq(replyAliases.relayDestination, input.relayDestination),
          isNull(replyAliases.revokedAt),
          isNull(users.disabledAt),
        ),
      )
      .orderBy(asc(replyAliases.createdAt), asc(replyAliases.id), asc(users.id))
      .limit(1)
    return row
  }

  async #listReplyContextMessages(
    mailboxId: string,
    threadId: string,
  ): Promise<ReplyContextMessage[]> {
    const rows = await this.#db
      .select({
        direction: messages.direction,
        fromAddress: messages.fromAddress,
        id: messages.id,
        inReplyTo: messages.inReplyTo,
        internetMessageId: messages.internetMessageId,
        providerMessageId: messages.providerMessageId,
        sentAt: messages.sentAt,
      })
      .from(messages)
      .where(and(eq(messages.mailboxId, mailboxId), eq(messages.threadId, threadId)))
      .orderBy(asc(messages.sentAt), asc(messages.id))
      .limit(500)
    return Promise.all(
      rows.map(async (message): Promise<ReplyContextMessage> => {
        const [replyTo, references] = await Promise.all([
          this.#db
            .select({ address: messageRecipients.address })
            .from(messageRecipients)
            .where(
              and(
                eq(messageRecipients.messageId, message.id),
                eq(messageRecipients.kind, 'reply_to'),
              ),
            )
            .orderBy(asc(messageRecipients.position)),
          this.#db
            .select({ internetMessageId: messageReferences.internetMessageId })
            .from(messageReferences)
            .where(eq(messageReferences.messageId, message.id))
            .orderBy(asc(messageReferences.position)),
        ])
        return {
          ...message,
          direction: message.direction as 'inbound' | 'outbound',
          references: references.map(({ internetMessageId }) => internetMessageId),
          replyTo: replyTo.map(({ address }) => address),
        }
      }),
    )
  }
}

function mailboxRecord(row: MailboxJoinRow): MailboxRecord {
  return {
    address: row.address,
    forwardTo: row.forwardTo,
    id: row.id,
    ownerUserId: row.ownerUserId,
    senderAlias: row.senderAlias,
  }
}

function requireChange(result: D1Result<unknown> | undefined, message: string): void {
  if ((result?.meta.changes ?? 0) === 0) throw new Error(message)
}
