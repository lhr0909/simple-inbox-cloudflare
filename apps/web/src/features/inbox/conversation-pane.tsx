import { HtmlMessageBody } from './html-message-body'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ArchiveIcon from 'lucide-react/dist/esm/icons/archive.mjs'
import ArrowLeftIcon from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import FileTextIcon from 'lucide-react/dist/esm/icons/file-text.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
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
  onReply,
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
  onReply?: InboxShellProps['onReply']
}>) {
  const [composerOpen, setComposerOpen] = useState(false)
  const scrollPane = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setComposerOpen(false)
    const frame = window.requestAnimationFrame(() => {
      const element = scrollPane.current
      if (element !== null) element.scrollTop = element.scrollHeight
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

  const archived = detail.thread.archivedAt !== null
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

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5" ref={scrollPane}>
        <div className="mx-auto max-w-3xl space-y-3">
          {detail.messages.map((message) => (
            <MessageCard key={message.id} message={message} renderHtml={renderHtml} />
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

function MessageCard({ message, renderHtml }: Readonly<{ message: Message; renderHtml: boolean }>) {
  const sender = message.from.displayName ?? message.from.address
  const delivery = messageDeliveryPresentation(message)
  return (
    <article className="content-auto rounded-xl border bg-background shadow-xs">
      <header className="flex gap-3 p-4">
        <Avatar size="lg">
          <AvatarFallback>{initials(sender)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-sm font-semibold">{sender}</p>
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
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            To: {visibleRecipients(message, 'to') || 'Undisclosed recipient'}
          </p>
          {visibleRecipients(message, 'cc') ? (
            <p className="truncate text-xs text-muted-foreground">
              Cc: {visibleRecipients(message, 'cc')}
            </p>
          ) : null}
          {message.direction === 'outbound' && visibleRecipients(message, 'bcc') ? (
            <p className="truncate text-xs text-muted-foreground">
              Bcc: {visibleRecipients(message, 'bcc')}
            </p>
          ) : null}
        </div>
      </header>
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
