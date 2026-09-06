import type { MailboxSettings, PatchMailboxRequest } from '@cloudflare-inbox/contracts/mailboxes'
import type { SendResponse } from '@cloudflare-inbox/contracts/send'

import type { InboxData, InboxQuery, NewMessageDraft, ReplyDraft } from './inbox-types'

type QueryChangeOptions = Readonly<{ replace?: boolean }>

export type InboxShellProps = Readonly<{
  data: InboxData
  query: InboxQuery
  busy?: boolean
  refreshing?: boolean
  loadingMore?: boolean
  detailLoading?: boolean
  detailError?: string | null
  onRetryThread?: () => void
  error?: string | null
  onQueryChange?: (
    update: Partial<InboxQuery>,
    options?: QueryChangeOptions,
  ) => Promise<void> | void
  onSelectThread?: (threadId: string) => Promise<void> | void
  onBack?: () => Promise<void> | void
  onRefresh?: () => Promise<boolean> | boolean
  onLoadMore?: () => Promise<void> | void
  onArchiveThread?: (threadId: string, archived: boolean) => Promise<void> | void
  onReply?: (threadId: string, draft: ReplyDraft) => Promise<SendResponse>
  onCompose?: (mailboxId: string, draft: NewMessageDraft) => Promise<SendResponse>
  onSignOut?: () => Promise<void> | void
  onUpdateMailbox?: (mailboxId: string, patch: PatchMailboxRequest) => Promise<MailboxSettings>
}>
