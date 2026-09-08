import type {
  ClaimQueuedSendInput,
  CompleteOutboundProjectionInput,
  InsertMessageProjectionInput,
  InsertInboundProjectionInput,
  NewThread,
  OutboundSendRecord,
  RecordOutboundAttemptInput,
  ReserveOutboundSendInput,
  ReserveOutboundSendResult,
} from '@cloudflare-inbox/db'
import { retryabilityForOutboundSendState } from '@cloudflare-inbox/db'
import {
  parseMailbox,
  parseReplyAlias,
  type SubjectThreadCandidate,
} from '@cloudflare-inbox/mail-core'

import type {
  MailBindings,
  MailDependencies,
  MailStore,
  MailboxRecord,
  OutboundContext,
  ReplyAliasRecord,
} from '../../src/types'
import { parseInboundMime } from '../../src/services/mime'

export const NOW = Date.parse('2026-08-01T04:10:00.000Z')
export const OWNER_USER_ID = testUuid(1)
export const MAILBOX_ID = testUuid(2)
export const THREAD_ID = testUuid(3)
export const INBOUND_MESSAGE_ID = testUuid(4)
export const OUTBOUND_MESSAGE_ID = testUuid(5)
export const SEND_ID = testUuid(6)
export const ALIAS_ID = testUuid(7)
export const ATTACHMENT_ID = testUuid(8)
export const ALIAS_TOKEN = 'abcdefghijklmnopqrstuvwxyz234567'

export class FakeMailStore implements MailStore {
  readonly aliases = new Map<string, ReplyAliasRecord>()
  readonly events: string[]
  readonly mailboxAddresses = new Map<string, string>([[MAILBOX_ID, 'support@example.test']])
  readonly projects: InsertMessageProjectionInput[] = []
  readonly sends = new Map<string, OutboundSendRecord>()
  readonly threads = new Map<string, NewThread>()
  allowedRelayDestinations = ['alice-replies@sender.example.test', 'alice@sender.example.test']
  context: OutboundContext = {
    mailbox: mailboxRecord(),
    messages: [],
    thread: undefined,
  }
  failProjection = false
  failReservation = false
  failWorkflow = false
  forwardHtml = true
  forwardTo: string | null = 'owner@example.test'

  constructor(events: string[] = []) {
    this.events = events
  }

  async claimPendingForward(input: { messageId: string; now: number }): Promise<boolean> {
    this.events.push('db:claim-forward')
    const projection = this.projects.find(({ message }) => message.id === input.messageId)
    if (
      projection === undefined ||
      projection.message.forwardState !== 'pending' ||
      projection.message.forwardAttemptedAt !== null
    ) {
      return false
    }
    projection.message.forwardAttemptedAt = input.now
    projection.message.forwardState = 'unknown'
    projection.message.providerErrorCode = 'owner_forward_claimed'
    projection.message.updatedAt = input.now
    return true
  }

  async claimQueuedSend(input: ClaimQueuedSendInput): Promise<boolean> {
    this.events.push('db:claim-send')
    const current = [...this.sends.values()].find(({ id }) => id === input.id)
    if (
      current === undefined ||
      current.actorUserId !== input.actorUserId ||
      current.mailboxId !== input.mailboxId ||
      current.requestDigest !== input.requestDigest ||
      current.state !== 'queued'
    ) {
      return false
    }
    this.sends.set(current.idempotencyKey, {
      ...current,
      attemptCount: current.attemptCount + 1,
      lastAttemptedAt: input.now,
      retryability: 'manual_confirmation_required',
      state: 'sending',
      updatedAt: input.now,
    })
    return true
  }

  async completeOutboundProjection(input: CompleteOutboundProjectionInput): Promise<void> {
    this.events.push('db:complete-outbound')
    if (this.failProjection) throw new Error('synthetic projection failure')
    if (this.failWorkflow) throw new Error('synthetic workflow failure')
    const current = [...this.sends.values()].find(({ id }) => id === input.outboundSendId)
    if (
      current === undefined ||
      current.actorUserId !== input.actorUserId ||
      current.mailboxId !== input.projection.message.mailboxId ||
      current.requestDigest !== input.requestDigest ||
      current.state !== 'sending'
    ) {
      throw new Error('Synthetic atomic completion lost its claimed send.')
    }
    if (
      input.projection.message.sendState !== 'sent' &&
      input.projection.message.sendState !== 'unknown'
    ) {
      throw new Error('Synthetic atomic completion received a non-terminal projection.')
    }
    this.projects.push(input.projection)
    this.sends.set(current.idempotencyKey, {
      ...current,
      messageId: input.projection.message.id,
      providerErrorCode: input.projection.message.providerErrorCode,
      providerMessageId: input.projection.message.providerMessageId,
      retryability: retryabilityForOutboundSendState(input.projection.message.sendState),
      state: input.projection.message.sendState as 'sent' | 'unknown',
      updatedAt: input.now,
    })
  }

  async ensureMailbox(input: {
    mailboxAddress: string
    mailboxId: string
    now: number
    ownerEmail: string
    userId: string
  }): Promise<MailboxRecord> {
    this.events.push('db:ensure-mailbox')
    this.mailboxAddresses.set(MAILBOX_ID, input.mailboxAddress)
    return {
      ...mailboxRecord(),
      address: input.mailboxAddress,
      forwardTo: this.forwardTo,
      forwardHtml: this.forwardHtml,
    }
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
    this.events.push('db:ensure-alias')
    const existing = [...this.aliases.values()].find(
      (alias) =>
        alias.mailboxId === input.mailboxId &&
        alias.threadId === input.threadId &&
        alias.targetMessageId === input.targetMessageId &&
        alias.relayDestination === input.relayDestination,
    )
    if (existing !== undefined) return existing
    if (this.aliases.has(input.localPart)) return undefined
    const alias = {
      localPart: input.localPart,
      mailboxId: input.mailboxId,
      ownerUserId: OWNER_USER_ID,
      relayDestination: input.relayDestination,
      targetMessageId: input.targetMessageId,
      threadId: input.threadId,
    }
    this.aliases.set(input.localPart, alias)
    return alias
  }

  async findInboundByDigest(
    ingestDigest: string,
  ): Promise<{ messageId: string; rawR2Key: string; threadId: string } | undefined> {
    const projection = this.projects.find(({ message }) => message.ingestDigest === ingestDigest)
    return projection === undefined
      ? undefined
      : {
          messageId: projection.message.id,
          rawR2Key: projection.message.rawR2Key,
          threadId: projection.message.threadId,
        }
  }

  async findSendByIdempotencyKey(idempotencyKey: string): Promise<OutboundSendRecord | undefined> {
    return this.sends.get(idempotencyKey)
  }

  async findThreadByMessageIds(
    _mailboxId: string,
    messageIds: readonly string[],
  ): Promise<string | undefined> {
    return messageIds.some((id) => id === '<known@example.test>') ? THREAD_ID : undefined
  }

  async getOutboundContext(input: {
    actorUserId: string
    mailboxId: string
    threadId?: string
  }): Promise<OutboundContext | undefined> {
    this.events.push('db:get-outbound-context')
    if (input.actorUserId !== OWNER_USER_ID || input.mailboxId !== MAILBOX_ID) return undefined
    if (input.threadId !== undefined && this.context.thread?.id !== input.threadId) return undefined
    return this.context
  }

  async getInboundForwardContext(messageId: string) {
    const projection = this.projects.find(({ message }) => message.id === messageId)
    if (projection === undefined || projection.message.receivedAt === null) return undefined
    return {
      attachments: projection.attachments.map(({ id, mimeOrdinal }) => ({ id, mimeOrdinal })),
      forwardState: projection.message.forwardState,
      mailbox: { ...mailboxRecord(), forwardTo: this.forwardTo, forwardHtml: this.forwardHtml },
      messageId,
      receivedAt: projection.message.receivedAt,
      threadId: projection.message.threadId,
    }
  }

  async hasRawProjection(input: {
    direction: 'inbound' | 'outbound'
    mailboxId: string
    rawSha256: string
  }): Promise<boolean> {
    return this.projects.some(
      ({ message }) =>
        message.direction === input.direction &&
        message.mailboxId === input.mailboxId &&
        message.rawSha256 === input.rawSha256,
    )
  }

  async listAllowedRelayDestinations(): Promise<string[]> {
    return this.allowedRelayDestinations
  }

  async listSubjectThreadCandidates(_input: {
    mailboxId: string
    normalizedSubject: string
    receivedAt: number
    windowMs: number
  }): Promise<SubjectThreadCandidate[]> {
    return []
  }

  async projectInboundMessage(input: InsertInboundProjectionInput): Promise<void> {
    this.events.push('db:project-inbound')
    if (this.failProjection) throw new Error('synthetic projection failure')
    if (this.failWorkflow) throw new Error('synthetic workflow failure')
    if (input.newThread !== undefined) this.threads.set(input.newThread.id, input.newThread)
    this.projects.push(input.projection)
  }

  async recordOutboundAttempt(input: RecordOutboundAttemptInput): Promise<void> {
    this.events.push(`db:send-${input.state}`)
    const current = [...this.sends.values()].find(({ id }) => id === input.id)
    if (current === undefined) throw new Error('Synthetic send transition lost its record.')
    this.sends.set(current.idempotencyKey, {
      ...current,
      attemptCount: current.attemptCount + 1,
      lastAttemptedAt: input.now,
      messageId: input.messageId,
      providerErrorCode: input.providerErrorCode,
      providerMessageId: input.providerMessageId,
      retryability: retryabilityForOutboundSendState(input.state),
      state: input.state,
      updatedAt: input.now,
    })
  }

  async reserveOutboundSend(input: ReserveOutboundSendInput): Promise<ReserveOutboundSendResult> {
    this.events.push('db:reserve-send')
    const existing = this.sends.get(input.idempotencyKey)
    if (existing !== undefined) {
      return existing.requestDigest === input.requestDigest
        ? { kind: 'replay', send: existing }
        : { kind: 'conflict' }
    }
    if (this.failReservation) throw new Error('synthetic reservation failure')
    if (input.newThread !== undefined) this.threads.set(input.newThread.id, input.newThread)
    const send: OutboundSendRecord = {
      actorUserId: input.actorUserId,
      attemptCount: 0,
      createdAt: input.createdAt,
      id: input.id,
      idempotencyKey: input.idempotencyKey,
      lastAttemptedAt: null,
      mailboxId: input.mailboxId,
      messageId: null,
      providerErrorCode: null,
      providerMessageId: null,
      requestDigest: input.requestDigest,
      retryability: 'retryable',
      state: 'queued',
      threadId: input.threadId,
      updatedAt: input.createdAt,
    }
    this.sends.set(input.idempotencyKey, send)
    return { kind: 'reserved', send }
  }

  async resolveReplyAlias(address: string): Promise<ReplyAliasRecord | undefined> {
    const candidate = parseMailbox(address)
    const parsedAlias = parseReplyAlias(candidate.address, { domain: candidate.domain })
    if (parsedAlias === null) return undefined
    const alias = this.aliases.get(parsedAlias.token)
    if (alias === undefined) return undefined
    const mailboxAddress = this.mailboxAddresses.get(alias.mailboxId)
    return mailboxAddress !== undefined && parseMailbox(mailboxAddress).domain === candidate.domain
      ? alias
      : undefined
  }

  async updateForwardResult(input: {
    messageId: string
    now: number
    providerErrorCode: string | null
    providerMessageId: string | null
    state: 'failed' | 'forwarded' | 'unknown'
  }): Promise<void> {
    this.events.push(`db:forward-${input.state}`)
    const projection = this.projects.find(({ message }) => message.id === input.messageId)
    if (projection !== undefined) {
      projection.message.forwardState = input.state
      projection.message.forwardAttemptedAt = input.now
      projection.message.providerErrorCode = input.providerErrorCode
      projection.message.providerMessageId = input.providerMessageId
    }
  }
}

export function createFakeEnvironment(
  options: {
    events?: string[]
    failEmail?: boolean
    failR2?: boolean
    failR2Delete?: boolean
    internalSecret?: string
    magicLinkFromEmail?: string
  } = {},
) {
  const events = options.events ?? []
  const objects = new Map<string, Uint8Array>()
  const sent: EmailMessageBuilder[] = []
  const bucket = {
    async delete(keys: string | string[]) {
      events.push('r2:delete')
      if (options.failR2Delete) throw new Error('synthetic R2 delete failure')
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
    async put(key: string, value: Uint8Array | ArrayBuffer | string) {
      events.push('r2:put')
      if (options.failR2) throw new Error('synthetic R2 failure')
      const bytes =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? new Uint8Array(value)
            : new Uint8Array(value)
      objects.set(key, bytes)
      return {} as R2Object
    },
  } as unknown as R2Bucket
  const email = {
    async send(builder: EmailMessageBuilder) {
      events.push('email:send')
      sent.push(builder)
      if (options.failEmail) throw new Error('synthetic provider uncertainty')
      return { messageId: '<provider-accepted@example.test>' }
    },
  } as SendEmail
  const env: MailBindings = {
    APPLICATION_RECORD_RETENTION_DAYS: '365',
    APP_ORIGIN: 'https://inbox.example.test',
    DB: {} as D1Database,
    EMAIL: email,
    ENVIRONMENT: 'test',
    ...(options.internalSecret === undefined
      ? {}
      : { INTERNAL_REQUEST_SECRET: options.internalSecret }),
    ...(options.magicLinkFromEmail === undefined
      ? {}
      : { MAGIC_LINK_FROM_EMAIL: options.magicLinkFromEmail }),
    MAIL_DOMAIN: 'example.test',
    OWNER_EMAIL: 'owner@example.test',
    RAW_EMAIL_RETENTION_DAYS: '365',
    RAW_EMAILS: bucket,
    RETENTION_BATCH_SIZE: '100',
  }
  return { env, events, objects, sent }
}

export function createDependencies(
  store: FakeMailStore,
  options: Partial<MailDependencies> = {},
): MailDependencies {
  let counter = 20
  return {
    createStore: () => store,
    generateAliasToken: () => ALIAS_TOKEN,
    generateId: () => testUuid(counter++),
    now: () => NOW,
    parseMime: parseInboundMime,
    ...options,
  }
}

export function createForwardableMessage(
  raw: Uint8Array,
  options: { from?: string; rawSize?: number; to?: string } = {},
): { message: ForwardableEmailMessage; rejected: string[] } {
  const rejected: string[] = []
  const message = {
    forward: async () => ({ messageId: '<unused-forward@example.test>' }),
    from: options.from ?? 'alice@sender.example.test',
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(raw)
        controller.close()
      },
    }),
    rawSize: options.rawSize ?? raw.byteLength,
    reply: async () => ({ messageId: '<unused-reply@example.test>' }),
    setReject(reason: string) {
      rejected.push(reason)
    },
    to: options.to ?? 'support@example.test',
  } as ForwardableEmailMessage
  return { message, rejected }
}

export function mailboxRecord(): MailboxRecord {
  return {
    address: 'support@example.test',
    forwardHtml: true,
    forwardTo: 'owner@example.test',
    id: MAILBOX_ID,
    ownerUserId: OWNER_USER_ID,
    senderAlias: 'Example Support',
  }
}

export function testUuid(counter: number): string {
  return `01996f7a-7bcd-7000-8000-${counter.toString(16).padStart(12, '0')}`
}
