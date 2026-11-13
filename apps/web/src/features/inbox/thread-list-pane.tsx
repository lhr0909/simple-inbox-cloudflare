import { useEffect, useRef, useState } from 'react'
import ArchiveRestoreIcon from 'lucide-react/dist/esm/icons/archive-restore.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
import RefreshIcon from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import SearchIcon from 'lucide-react/dist/esm/icons/search.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'
import ShieldIcon from 'lucide-react/dist/esm/icons/shield-alert.mjs'
import ShieldCheckIcon from 'lucide-react/dist/esm/icons/shield-check.mjs'
import TrashIcon from 'lucide-react/dist/esm/icons/trash-2.mjs'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'

import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'
import type { ThreadSummary } from '@cloudflare-inbox/contracts/threads'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

import { initials, participantLabel } from './inbox-model'
import type { InboxQuery } from './inbox-types'

import { EmptyList, HydratedTime } from './inbox-primitives'
import type { BulkMoveLocation, InboxShellProps } from './inbox-shell-types'

type BulkMove = Readonly<{ location: BulkMoveLocation; threads: readonly ThreadSummary[] }>

const UNDO_WINDOW_MS = 8_000

const BULK_ACTIONS: Readonly<
  Record<
    BulkMoveLocation,
    Readonly<{ label: string; icon: typeof TrashIcon; undo: BulkMoveLocation; done: string }>
  >
> = {
  trash: { label: 'Trash', icon: TrashIcon, undo: 'restore', done: 'moved to Trash' },
  spam: { label: 'Spam', icon: ShieldIcon, undo: 'not_spam', done: 'moved to Spam' },
  restore: {
    label: 'Restore',
    icon: ArchiveRestoreIcon,
    undo: 'trash',
    done: 'restored from Trash',
  },
  not_spam: { label: 'Not spam', icon: ShieldCheckIcon, undo: 'spam', done: 'marked as not spam' },
}

function bulkLocations(folder: ThreadFolder): readonly BulkMoveLocation[] {
  if (folder === 'trash') return ['restore']
  if (folder === 'spam') return ['trash', 'not_spam']
  return ['trash', 'spam']
}

export function ThreadListPane({
  className,
  busy,
  mailboxAddress,
  aliasAddresses,
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
  onBulkMove,
}: Readonly<{
  className?: string
  busy: boolean
  mailboxAddress: string
  aliasAddresses?: Readonly<Record<string, string>>
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
  onBulkMove?: InboxShellProps['onBulkMove']
}>) {
  const [searchDraft, setSearchDraft] = useState(query.search)
  const previousQuerySearch = useRef(query.search)
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set())
  const [moving, setMoving] = useState(false)
  const [lastMove, setLastMove] = useState<BulkMove | null>(null)
  const listKey = `${query.mailboxId}:${query.folder}:${query.unreadOnly}:${query.search}`
  const checkedIds = threads.filter((thread) => checked.has(thread.id)).map((thread) => thread.id)
  const allChecked = threads.length > 0 && checkedIds.length === threads.length
  const rangeAnchor = useRef<string | null>(null)

  useEffect(() => {
    setChecked(new Set())
    setLastMove(null)
    rangeAnchor.current = null
  }, [listKey])

  useEffect(() => {
    if (lastMove === null || moving) return
    const timeout = window.setTimeout(() => setLastMove(null), UNDO_WINDOW_MS)
    return () => window.clearTimeout(timeout)
  }, [lastMove, moving])

  useEffect(() => {
    if (checked.size === 0) return
    function clearOnEscape(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable], dialog, [role="dialog"]'))
        return
      setChecked(new Set())
    }
    document.addEventListener('keydown', clearOnEscape)
    return () => document.removeEventListener('keydown', clearOnEscape)
  }, [checked])

  function toggleThread(threadId: string, value: boolean, extendRange: boolean): void {
    const ids: readonly string[] = threads.map((thread) => thread.id)
    const anchor = rangeAnchor.current === null ? -1 : ids.indexOf(rangeAnchor.current)
    const target = ids.indexOf(threadId)
    const range =
      extendRange && anchor !== -1 && target !== -1
        ? ids.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
        : [threadId]
    rangeAnchor.current = threadId
    setChecked((current) => {
      const next = new Set(current)
      for (const id of range) {
        if (value) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  async function moveChecked(location: BulkMoveLocation): Promise<void> {
    if (!onBulkMove || checkedIds.length === 0) return
    const rows = threads.filter((thread) => checked.has(thread.id))
    setMoving(true)
    try {
      const result = await onBulkMove(checkedIds, location)
      const succeeded = new Set(result.succeeded)
      setChecked(new Set(result.failed))
      setLastMove(
        succeeded.size > 0
          ? { location, threads: rows.filter((thread) => succeeded.has(thread.id)) }
          : null,
      )
    } finally {
      setMoving(false)
    }
  }

  async function undoLastMove(): Promise<void> {
    if (!onBulkMove || lastMove === null) return
    setMoving(true)
    try {
      const result = await onBulkMove(
        lastMove.threads.map((thread) => thread.id),
        BULK_ACTIONS[lastMove.location].undo,
        lastMove.threads,
      )
      const failed = new Set(result.failed)
      setLastMove(
        failed.size > 0
          ? { ...lastMove, threads: lastMove.threads.filter((thread) => failed.has(thread.id)) }
          : null,
      )
    } finally {
      setMoving(false)
    }
  }

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
          <Button
            onClick={onCompose}
            size="sm"
            disabled={query.mailboxId === 'other' || !query.mailboxId}
            title={query.mailboxId === 'other' ? 'Choose or create an inbox to compose' : undefined}
          >
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

      <div className="flex items-center gap-3 border-b p-3 pl-4">
        <Checkbox
          aria-label="Select all conversations in view"
          checked={allChecked}
          disabled={threads.length === 0 || moving}
          indeterminate={checkedIds.length > 0 && !allChecked}
          onCheckedChange={(value) =>
            setChecked(value ? new Set(threads.map((thread) => thread.id)) : new Set())
          }
        />
        <div className="relative min-w-0 flex-1">
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

      {checkedIds.length > 0 ? (
        <div
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-3 py-1.5"
          role="toolbar"
        >
          <span className="mr-auto pl-1 text-xs font-medium">{checkedIds.length} selected</span>
          {bulkLocations(query.folder).map((location) => {
            const { label, icon: Icon } = BULK_ACTIONS[location]
            return (
              <Button
                disabled={busy || moving}
                key={location}
                onClick={() => void moveChecked(location)}
                size="sm"
                variant="ghost"
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </Button>
            )
          })}
          <Button
            aria-label="Clear selection"
            disabled={moving}
            onClick={() => setChecked(new Set())}
            size="icon-sm"
            title="Clear selection"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>
      ) : null}

      {lastMove !== null ? (
        <div
          className="flex items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <span className="mr-auto">
            {lastMove.threads.length} conversation{lastMove.threads.length === 1 ? '' : 's'}{' '}
            {BULK_ACTIONS[lastMove.location].done}.
          </span>
          <Button disabled={moving} onClick={() => void undoLastMove()} size="xs" variant="outline">
            Undo
          </Button>
          <Button
            aria-label="Dismiss"
            onClick={() => setLastMove(null)}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div
        aria-busy={busy || refreshing || moving}
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
              aliasAddress={
                query.mailboxId === 'other' ? aliasAddresses?.[thread.mailboxId] : undefined
              }
              active={selectedThreadId === thread.id}
              checked={checked.has(thread.id)}
              checkDisabled={moving}
              key={thread.id}
              onCheckedChange={(value, extendRange) => toggleThread(thread.id, value, extendRange)}
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
  aliasAddress,
  active,
  checked,
  checkDisabled,
  onCheckedChange,
  onSelect,
  thread,
}: Readonly<{
  aliasAddress?: string | undefined
  active: boolean
  checked: boolean
  checkDisabled: boolean
  onCheckedChange: (checked: boolean, extendRange: boolean) => void
  onSelect?: InboxShellProps['onSelectThread']
  thread: ThreadSummary
}>) {
  const label = participantLabel(thread)
  const shiftPressed = useRef(false)
  return (
    <div
      className={cn(
        'content-auto flex border-b transition-colors hover:bg-muted/60',
        checked && 'bg-primary/5',
        active && 'bg-muted',
      )}
    >
      <div
        className="flex shrink-0 items-start pt-[1.375rem] pl-4"
        onPointerDownCapture={(event) => {
          shiftPressed.current = event.shiftKey
        }}
      >
        <Checkbox
          aria-label={`Select conversation: ${thread.subject || '(no subject)'}`}
          checked={checked}
          disabled={checkDisabled}
          onCheckedChange={(value) => {
            onCheckedChange(value, shiftPressed.current)
            shiftPressed.current = false
          }}
        />
      </div>
      <button
        aria-pressed={active}
        className="relative flex min-w-0 flex-1 gap-3 py-3 pr-4 pl-3 text-left focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring"
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
          {aliasAddress ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">To: {aliasAddress}</p>
          ) : null}
          <div className="mt-2 flex min-h-5 items-center gap-1.5">
            {thread.attachmentCount > 0 ? (
              <PaperclipIcon
                className="size-3 text-muted-foreground"
                aria-label="Has attachments"
              />
            ) : null}
            {thread.hasStarred ? (
              <span aria-label="Starred" className="text-amber-500">
                ★
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
    </div>
  )
}
