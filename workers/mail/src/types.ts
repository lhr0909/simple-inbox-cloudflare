import type { InternalSendRequest, SendResponse } from '@cloudflare-inbox/contracts'
import type {
  ClaimQueuedSendInput,
  CompleteOutboundProjectionInput,
  InsertInboundProjectionInput,
  MessageProjection,
  OutboundSendRecord,
  RecordOutboundAttemptInput,
  ReserveOutboundSendInput,
  ReserveOutboundSendResult,
} from '@cloudflare-inbox/db'
import type { SubjectThreadCandidate } from '@cloudflare-inbox/mail-core'

export type MailBindings = Omit<
  CloudflareBindings,
  | 'APPLICATION_RECORD_RETENTION_DAYS'
  | 'APP_ORIGIN'
  | 'ENVIRONMENT'
  | 'MAIL_DOMAIN'
  | 'OWNER_EMAIL'
  | 'RAW_EMAIL_RETENTION_DAYS'
  | 'RETENTION_BATCH_SIZE'
> & {
  APPLICATION_RECORD_RETENTION_DAYS: string
  APP_ORIGIN: string
  ENVIRONMENT: string
  /** Optional defense in depth for deliberately exposed HTTP deployments. */
  INTERNAL_REQUEST_SECRET?: string
  MAIL_DOMAIN: string
  OWNER_EMAIL: string
  RAW_EMAIL_RETENTION_DAYS: string
  RETENTION_BATCH_SIZE: string
}

export type MailVariables = {
  requestId: string
}

export type MailEnv = {
  Bindings: MailBindings
  Variables: MailVariables
}

export type NormalizedAttachment = {
  bytes: Uint8Array
  contentId: string | null
  disposition: 'attachment' | 'inline' | 'unknown'
  filename: string
  mediaType: string
}

export type NormalizedRecipient = {
  address: string
  displayName: string | null
}

export type NormalizedInboundMessage = {
  attachments: NormalizedAttachment[]
  bcc: NormalizedRecipient[]
  cc: NormalizedRecipient[]
  from: NormalizedRecipient
  html: string
  inReplyTo: string | null
  internetMessageId: string | null
  references: string[]
  replyTo: NormalizedRecipient[]
  sentAt: number
  subject: string
  text: string
  to: NormalizedRecipient[]
}

export type MailboxRecord = {
  address: string
  forwardTo: string | null
  id: string
  ownerUserId: string
  senderAlias: string | null
}

export type ReplyAliasRecord = {
  localPart: string
  mailboxId: string
  ownerUserId: string
  relayDestination: string
  targetMessageId: string | null
  threadId: string
}

export type ReplyContextMessage = {
  direction: 'inbound' | 'outbound'
  fromAddress: string
  id: string
  inReplyTo: string | null
  internetMessageId: string | null
  providerMessageId: string | null
  references: string[]
  replyTo: string[]
  sentAt: number
}

export type OutboundContext = {
  mailbox: MailboxRecord
  messages: ReplyContextMessage[]
  thread:
    | {
        archivedAt: number | null
        id: string
        subject: string
      }
    | undefined
}

export type InboundForwardContext = {
  attachments: Array<{ id: string; mimeOrdinal: number }>
  forwardState: 'failed' | 'forwarded' | 'not_applicable' | 'pending' | 'unknown'
  mailbox: MailboxRecord
  messageId: string
  receivedAt: number
  threadId: string
}

export interface MailStore {
  claimPendingForward(input: { messageId: string; now: number }): Promise<boolean>
  claimQueuedSend(input: ClaimQueuedSendInput): Promise<boolean>
  completeOutboundProjection(input: CompleteOutboundProjectionInput): Promise<void>
  ensureMailbox(input: {
    mailboxAddress: string
    mailboxId: string
    now: number
    ownerEmail: string
    userId: string
  }): Promise<MailboxRecord>
  ensureReplyAlias(input: {
    aliasId: string
    localPart: string
    mailboxId: string
    now: number
    relayDestination: string
    targetMessageId: string
    threadId: string
  }): Promise<ReplyAliasRecord | undefined>
  findInboundByDigest(
    ingestDigest: string,
  ): Promise<{ messageId: string; rawR2Key: string; threadId: string } | undefined>
  findSendByIdempotencyKey(idempotencyKey: string): Promise<OutboundSendRecord | undefined>
  findThreadByMessageIds(
    mailboxId: string,
    messageIds: readonly string[],
  ): Promise<string | undefined>
  getOutboundContext(input: {
    actorUserId: string
    mailboxId: string
    threadId?: string
  }): Promise<OutboundContext | undefined>
  getInboundForwardContext(messageId: string): Promise<InboundForwardContext | undefined>
  hasRawProjection(input: {
    direction: 'inbound' | 'outbound'
    mailboxId: string
    rawSha256: string
  }): Promise<boolean>
  listAllowedRelayDestinations(mailboxId: string, threadId: string): Promise<string[]>
  listSubjectThreadCandidates(input: {
    mailboxId: string
    normalizedSubject: string
    receivedAt: number
    windowMs: number
  }): Promise<SubjectThreadCandidate[]>
  projectInboundMessage(input: InsertInboundProjectionInput): Promise<void>
  recordOutboundAttempt(input: RecordOutboundAttemptInput): Promise<void>
  reserveOutboundSend(input: ReserveOutboundSendInput): Promise<ReserveOutboundSendResult>
  resolveReplyAlias(localPart: string): Promise<ReplyAliasRecord | undefined>
  updateForwardResult(input: {
    messageId: string
    now: number
    providerErrorCode: string | null
    providerMessageId: string | null
    state: 'failed' | 'forwarded' | 'unknown'
  }): Promise<void>
}

export interface MailDependencies {
  createStore(binding: D1Database): MailStore
  generateAliasToken(): string
  generateId(now: number): string
  now(): number
  parseMime(raw: Uint8Array, receivedAt: number): Promise<NormalizedInboundMessage>
}

export type InternalSendResult = {
  response: SendResponse
  status: 201 | 202
}

export type PreparedInternalSend = {
  attachments: File[]
  request: InternalSendRequest
}

export type ProjectableMessage = MessageProjection
