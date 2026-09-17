import { HtmlMessageBody } from './html-message-body'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ArchiveIcon from 'lucide-react/dist/esm/icons/archive.mjs'
import ArrowLeftIcon from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import FileTextIcon from 'lucide-react/dist/esm/icons/file-text.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
import StarIcon from 'lucide-react/dist/esm/icons/star.mjs'
import TrashIcon from 'lucide-react/dist/esm/icons/trash-2.mjs'
import MailIcon from 'lucide-react/dist/esm/icons/mail.mjs'
import ShieldIcon from 'lucide-react/dist/esm/icons/shield-alert.mjs'
import ChevronIcon from 'lucide-react/dist/esm/icons/chevron-down.mjs'
import ReplyIcon from 'lucide-react/dist/esm/icons/reply.mjs'

import type { Message } from '@cloudflare-inbox/contracts/messages'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Badge } from '#/components/ui/badge'
import { Button, buttonVariants } from '#/components/ui/button'
import { Separator } from '#/components/ui/separator'
import { cn } from '#/lib/utils'

import {
  inboundReplyTargets,
  initials,
  messageDeliveryPresentation,
  participantLabel,
  visibleRecipients,
} from './inbox-model'
import type { InboxData } from './inbox-types'

import { HydratedTime } from './inbox-primitives'
import { ReplyComposer } from './reply-composer'
import type { InboxShellProps } from './inbox-shell-types'

export function ConversationPane({
  className,
  detail,
  renderHtml = false,
  loading,
  error,
  onRetry,
  busy,
  onBack,
  onArchiveThread,
  onMessageState,
  onReply,
  aliasNotice,
}: Readonly<{
  className?: string
  renderHtml?: boolean
  detail: InboxData['selectedThread']
  loading: boolean
  error: string | null
  onRetry?: (() => void) | undefined
  busy: boolean
  onBack?: InboxShellProps['onBack']
  onArchiveThread?: InboxShellProps['onArchiveThread']
  onMessageState?: InboxShellProps['onMessageState']
  onReply?: InboxShellProps['onReply']
  aliasNotice?: ReactNode
}>) {
  const [expandAll, setExpandAll] = useState<boolean | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const scrollPane = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setComposerOpen(false)
    setExpandAll(null)
    const frame = window.requestAnimationFrame(() => {
      const element = scrollPane.current
      if (element !== null) element.scrollTop = 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [detail?.thread.id])

  if (!detail) {
    return (
      <section
        data-testid="conversation-pane"
        aria-busy={loading}
        className={cn(
          'relative min-w-0 flex-1 items-center justify-center bg-muted/20 p-8 text-center',
          className,
        )}
      >
        <Button
          aria-label="Back to conversations"
          className="absolute top-3 left-3 md:hidden"
          onClick={() => void onBack?.()}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </Button>
        <div role={error ? 'alert' : 'status'}>
          <MailOpenIcon aria-hidden="true" className="mx-auto size-9 text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">
            {loading
              ? 'Loading conversation…'
              : error
                ? 'Conversation unavailable'
                : 'Choose a conversation'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {error ??
              (loading
                ? 'Your messages will appear here shortly.'
                : 'Messages and reply controls appear here.')}
          </p>
          {error ? (
            <Button className="mt-3" onClick={onRetry} variant="outline">
              Retry conversation
            </Button>
          ) : null}
        </div>
      </section>
    )
  }

  const archived = !detail.thread.hasInbox
  const canReply = inboundReplyTargets(detail.messages).length > 0
  return (
    <section
      className={cn('min-h-0 min-w-0 flex-1 flex-col bg-muted/20', className)}
      data-testid="conversation-pane"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
        <Button
          aria-label="Back to conversations"
          className="md:hidden"
          onClick={() => void onBack?.()}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">
            {detail.thread.subject || '(no subject)'}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {detail.thread.messageCount} messages · {participantLabel(detail.thread)}
          </p>
        </div>
        <Button
          disabled={busy}
          onClick={() => void onArchiveThread?.(detail.thread.id, !archived)}
          size="sm"
          variant="ghost"
        >
          <ArchiveIcon aria-hidden="true" className="size-4" />
          {archived ? 'Restore' : 'Archive'}
        </Button>
        <Button
          disabled={busy || !canReply}
          onClick={() => setComposerOpen(true)}
          size="sm"
          title={canReply ? undefined : 'No inbound message is available to reply to'}
        >
          <ReplyIcon aria-hidden="true" className="size-4" />
          Reply
        </Button>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b bg-background px-3 py-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void onMessageState?.(detail.thread.id, { read: false })}
        >
          <MailIcon className="size-4" />
          Mark unread
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void onMessageState?.(detail.thread.id, {
              location: detail.thread.hasTrash ? 'restore' : 'trash',
            })
          }
        >
          <TrashIcon className="size-4" />
          {detail.thread.hasTrash ? 'Restore from trash' : 'Trash'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void onMessageState?.(detail.thread.id, {
              location: detail.thread.hasSpam ? 'not_spam' : 'spam',
            })
          }
        >
          <ShieldIcon className="size-4" />
          {detail.thread.hasSpam ? 'Not spam' : 'Spam'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => setExpandAll((current) => (current === true ? false : true))}
        >
          {expandAll === true ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>
      {aliasNotice}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5" ref={scrollPane}>
        <div className="mx-auto max-w-3xl space-y-3">
          {detail.messages.map((message, index) => (
            <MessageCard
              key={message.id}
              message={message}
              renderHtml={renderHtml && message.spamAt === null}
              initiallyOpen={
                index === detail.messages.length - 1 ||
                (message.direction === 'inbound' && message.readAt === null)
              }
              expandAll={expandAll}
              onMessageState={onMessageState}
            />
          ))}
          {composerOpen && canReply ? (
            <ReplyComposer
              detail={detail}
              key={detail.thread.id}
              onCancel={() => setComposerOpen(false)}
              onReply={onReply}
            />
          ) : canReply ? (
            <Button
              className="w-full justify-start bg-background"
              onClick={() => setComposerOpen(true)}
              variant="outline"
            >
              <ReplyIcon aria-hidden="true" className="size-4" />
              Reply to this conversation
            </Button>
          ) : (
            <p className="rounded-xl border bg-background p-4 text-sm text-muted-foreground">
              This conversation has no inbound message to reply to. Start a new message from the
              conversation list instead.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function MessageCard({
  message,
  renderHtml,
  initiallyOpen,
  expandAll,
  onMessageState,
}: Readonly<{
  message: Message
  renderHtml: boolean
  initiallyOpen: boolean
  expandAll: boolean | null
  onMessageState?: InboxShellProps['onMessageState']
}>) {
  const [expanded, setExpanded] = useState(initiallyOpen)
  const readAttempted = useRef(false)
  useEffect(() => {
    if (expandAll !== null) setExpanded(expandAll)
  }, [expandAll])
  useEffect(() => {
    if (
      !expanded ||
      message.direction !== 'inbound' ||
      message.readAt !== null ||
      readAttempted.current
    )
      return
    readAttempted.current = true
    void onMessageState?.(message.threadId, { read: true, messageIds: [message.id] })
  }, [expanded, message.direction, message.id, message.readAt, message.threadId, onMessageState])
  const sender = message.from.displayName ?? message.from.address
  const cc = visibleRecipients(message, 'cc')
  const bcc = message.direction === 'outbound' ? visibleRecipients(message, 'bcc') : ''
  const delivery = messageDeliveryPresentation(message)
  return (
    <article className="content-auto rounded-xl border bg-background shadow-xs">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`message-${message.id}`}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ChevronIcon
            className={cn('size-4 shrink-0 transition-transform', !expanded && '-rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{sender}</span>
            {!expanded ? (
              <span className="block truncate text-xs text-muted-foreground">
                {message.preview || '(no content)'}
              </span>
            ) : null}
          </span>
          <HydratedTime
            className="shrink-0 text-xs text-muted-foreground"
            presentation="thread"
            value={message.sentAt}
          />
        </button>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={message.starredAt ? 'Unstar message' : 'Star message'}
          aria-pressed={message.starredAt !== null}
          onClick={() =>
            void onMessageState?.(message.threadId, {
              starred: message.starredAt === null,
              messageIds: [message.id],
            })
          }
        >
          <StarIcon
            className={cn('size-4', message.starredAt !== null && 'fill-amber-400 text-amber-500')}
          />
        </Button>
      </div>
      {expanded ? (
        <div id={`message-${message.id}`}>
          <header className="flex gap-3 px-4 pb-3">
            <Avatar size="lg">
              <AvatarFallback>{initials(sender)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="min-w-0 break-all text-sm font-semibold">{sender}</p>
                {delivery ? <Badge variant={delivery.variant}>{delivery.label}</Badge> : null}
                {message.readAt === null && message.direction === 'inbound' ? (
                  <Badge variant="secondary">New</Badge>
                ) : null}
                <HydratedTime
                  className="ml-auto text-xs text-muted-foreground"
                  presentation="full"
                  value={message.sentAt}
                />
              </div>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">
                From: {message.from.address}
              </p>
              <p className="mt-0.5 break-all text-xs text-muted-foreground">
                To: {visibleRecipients(message, 'to') || 'Undisclosed recipient'}
              </p>
              {cc || bcc ? (
                <p className="mt-0.5 flex flex-wrap gap-x-3 break-all text-xs text-muted-foreground">
                  {cc ? <span>Cc: {cc}</span> : null}
                  {bcc ? <span>Bcc: {bcc}</span> : null}
                </p>
              ) : null}
            </div>
          </header>
          {message.spamAt !== null ? (
            <p className="border-t bg-muted px-4 py-2 text-xs">
              Spam ·{' '}
              {message.spamReason === 'blacklist_recipient'
                ? 'Blocked inbound alias'
                : message.spamReason === 'blacklist_sender'
                  ? 'Blocked sender address'
                  : message.spamReason === 'blacklist_domain'
                    ? 'Blocked sender domain'
                    : 'Marked as spam'}
            </p>
          ) : null}
          {message.trashedAt !== null ? (
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">In Trash</p>
          ) : null}
          <Separator />
          {delivery?.notice ? (
            <p
              className={cn(
                'border-b px-4 py-2 text-xs leading-5',
                delivery.variant === 'destructive'
                  ? 'bg-destructive/5 text-destructive'
                  : 'bg-muted/50 text-muted-foreground',
              )}
            >
              {delivery.notice}
            </p>
          ) : null}
          {renderHtml && message.rawAvailable ? (
            <HtmlMessageBody
              messageId={message.id}
              renderFooter={(toggle) => <MessageFooter message={message} displayToggle={toggle} />}
              text={message.textBody || message.preview}
            />
          ) : (
            <>
              <div className="whitespace-pre-wrap p-4 text-sm leading-6">
                {message.textBody || message.preview}
              </div>
              <MessageFooter message={message} />
            </>
          )}
        </div>
      ) : null}
    </article>
  )
}

function MessageFooter({
  message,
  displayToggle,
}: Readonly<{ message: Message; displayToggle?: ReactNode }>) {
  if (message.attachments.length === 0 && !message.rawAvailable) return null
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
      {message.attachments.map((attachment) => (
        <a
          className={buttonVariants({ size: 'sm', variant: 'outline' })}
          href={`/api/v1/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.id)}`}
          key={attachment.id}
        >
          <PaperclipIcon aria-hidden="true" className="size-4" />
          {attachment.filename ?? 'Attachment'}
        </a>
      ))}
      {message.rawAvailable ? (
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {displayToggle}
          <a
            className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            href={`/api/v1/messages/${encodeURIComponent(message.id)}/raw`}
          >
            <FileTextIcon aria-hidden="true" className="size-4" />
            Raw email
          </a>
        </div>
      ) : null}
    </footer>
  )
}
