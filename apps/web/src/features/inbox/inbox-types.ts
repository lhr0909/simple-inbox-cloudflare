import type { MailboxSummary } from '@cloudflare-inbox/contracts/mailboxes'
import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'
import type { ThreadDetailResponse, ThreadSummary } from '@cloudflare-inbox/contracts/threads'

export type InboxData = Readonly<{
  mailboxes: readonly MailboxSummary[]
  threads: readonly ThreadSummary[]
  selectedThread: ThreadDetailResponse | null
  nextCursor: string | null
}>

export type InboxQuery = Readonly<{
  mailboxId: string
  folder: ThreadFolder
  unreadOnly: boolean
  search: string
  threadId: string | null
}>

export type ReplyDraft = Readonly<{
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  attachments: readonly File[]
  idempotencyKey: string
  targetMessageId: string | null
}>

export type NewMessageDraft = Readonly<{
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  attachments: readonly File[]
  idempotencyKey: string
}>

export type OptimisticThreadState = Readonly<{
  archivedAt?: string | null
  readAt?: string
  unreadCount?: number
}>

export type ComposeStatus = 'idle' | 'sending' | 'accepted' | 'uncertain' | 'error'
