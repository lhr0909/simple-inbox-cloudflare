import { useEffect, useRef, useState } from 'react'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
import RefreshIcon from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import SearchIcon from 'lucide-react/dist/esm/icons/search.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'

import type { ThreadSummary } from '@cloudflare-inbox/contracts/threads'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

import { initials, participantLabel } from './inbox-model'
import type { InboxQuery } from './inbox-types'

import { EmptyList, HydratedTime } from './inbox-primitives'
import type { InboxShellProps } from './inbox-shell-types'

export function ThreadListPane({
  className,
  busy,
  mailboxAddress,
  nextCursor,
  query,
  refreshing,
  loadingMore,
  threads,
  selectedThreadId,
  onQueryChange,
  onCompose,
  onLoadMore,
  onRefresh,
  onSelectThread,
}: Readonly<{
  className?: string
  busy: boolean
  mailboxAddress: string
  nextCursor: string | null
  query: InboxQuery
  refreshing: boolean
  loadingMore: boolean
  threads: readonly ThreadSummary[]
  selectedThreadId: string | null
  onQueryChange?: InboxShellProps['onQueryChange']
  onCompose: () => void
  onLoadMore?: InboxShellProps['onLoadMore']
  onRefresh?: InboxShellProps['onRefresh']
  onSelectThread?: InboxShellProps['onSelectThread']
}>) {
  const [searchDraft, setSearchDraft] = useState(query.search)
  const previousQuerySearch = useRef(query.search)

  useEffect(() => {
    const previousSearch = previousQuerySearch.current
    previousQuerySearch.current = query.search
    setSearchDraft((current) => (current === previousSearch ? query.search : current))
  }, [query.search])

  useEffect(() => {
    if (searchDraft === query.search) return
    const timeout = window.setTimeout(() => {
      void onQueryChange?.({ search: searchDraft }, { replace: true })
    }, 300)
    return () => window.clearTimeout(timeout)
  }, [onQueryChange, query.search, searchDraft])

  return (
    <section className={cn('min-h-0 min-w-0 flex-col border-r bg-background', className)}>
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-4">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{mailboxAddress}</h1>
          <p className="text-xs text-muted-foreground">
            {threads.length} conversation{threads.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button onClick={onCompose} size="sm">
            <SendIcon aria-hidden="true" className="size-4" />
            Compose
          </Button>
          <Button
            aria-label="Refresh inbox"
            disabled={refreshing}
            onClick={() => void onRefresh?.()}
            size="icon-sm"
            title="Refresh inbox"
            variant="ghost"
          >
            <RefreshIcon
              aria-hidden="true"
              className={cn('size-4', refreshing && 'animate-spin')}
            />
          </Button>
          <Button
            aria-pressed={query.unreadOnly}
            onClick={() => void onQueryChange?.({ unreadOnly: !query.unreadOnly })}
            size="sm"
            variant={query.unreadOnly ? 'secondary' : 'ghost'}
          >
            <MailOpenIcon aria-hidden="true" className="size-4" />
            Unread
          </Button>
        </div>
      </header>

      <div className="border-b p-3">
        <div className="relative">
          <SearchIcon
            aria-hidden="true"
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search conversations"
            className="h-9 pl-9"
            maxLength={200}
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="Search mail"
            type="search"
            value={searchDraft}
          />
        </div>
      </div>

      <div
        aria-busy={busy || refreshing}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="thread-list"
      >
        {threads.length === 0 ? (
          <EmptyList
            description={
              query.mailboxId
                ? 'Try another folder or clear the search.'
                : 'No mailbox is assigned to this account.'
            }
            title="No conversations"
          />
        ) : (
          threads.map((thread) => (
            <ThreadRow
              active={selectedThreadId === thread.id}
              key={thread.id}
              onSelect={onSelectThread}
              thread={thread}
            />
          ))
        )}
        {nextCursor !== null ? (
          <div className="border-t p-3 text-center">
            <Button
              disabled={busy || loadingMore || refreshing}
              onClick={() => void onLoadMore?.()}
              size="sm"
              variant="outline"
            >
              {loadingMore ? 'Loading more…' : 'Load more conversations'}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

function ThreadRow({
  active,
  onSelect,
  thread,
}: Readonly<{
  active: boolean
  onSelect?: InboxShellProps['onSelectThread']
  thread: ThreadSummary
}>) {
  const label = participantLabel(thread)
  return (
    <button
      aria-pressed={active}
      className={cn(
        'content-auto relative flex w-full gap-3 border-b px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring',
        active && 'bg-muted',
      )}
      onClick={() => void onSelect?.(thread.id)}
      type="button"
    >
      <Avatar className="mt-0.5" size="lg">
        <AvatarFallback>{initials(label)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              thread.unreadCount > 0 && 'font-semibold',
            )}
          >
            {label}
          </p>
          <HydratedTime
            className="shrink-0 text-xs text-muted-foreground"
            presentation="thread"
            value={thread.lastMessageAt}
          />
        </div>
        <p
          className={cn(
            'mt-0.5 truncate text-sm',
            thread.unreadCount > 0 ? 'font-medium' : 'text-muted-foreground',
          )}
        >
          {thread.subject || '(no subject)'}
        </p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {thread.preview}
        </p>
        <div className="mt-2 flex min-h-5 items-center gap-1.5">
          {thread.workflowState === 'needs_reply' ? (
            <Badge variant="secondary">Needs reply</Badge>
          ) : null}
          {thread.workflowState === 'waiting' ? <Badge variant="outline">Waiting</Badge> : null}
          {thread.attachmentCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <PaperclipIcon aria-hidden="true" className="size-3" />
              {thread.attachmentCount}
            </span>
          ) : null}
          {thread.unreadCount > 0 ? (
            <span
              className="ml-auto size-2 rounded-full bg-primary"
              aria-label={`${thread.unreadCount} unread`}
            />
          ) : null}
        </div>
      </div>
    </button>
  )
}
