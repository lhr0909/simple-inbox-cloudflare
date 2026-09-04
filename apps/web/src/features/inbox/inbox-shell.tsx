import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import type {
  CSSProperties,
  ComponentType,
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  SVGProps,
} from 'react'
import ArchiveIcon from 'lucide-react/dist/esm/icons/archive.mjs'
import ArrowLeftIcon from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import CheckCircleIcon from 'lucide-react/dist/esm/icons/circle-check.mjs'
import ClockIcon from 'lucide-react/dist/esm/icons/clock-3.mjs'
import FileTextIcon from 'lucide-react/dist/esm/icons/file-text.mjs'
import InboxIcon from 'lucide-react/dist/esm/icons/inbox.mjs'
import LogOutIcon from 'lucide-react/dist/esm/icons/log-out.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import PanelLeftCloseIcon from 'lucide-react/dist/esm/icons/panel-left-close.mjs'
import PanelLeftOpenIcon from 'lucide-react/dist/esm/icons/panel-left-open.mjs'
import PaperclipIcon from 'lucide-react/dist/esm/icons/paperclip.mjs'
import RefreshIcon from 'lucide-react/dist/esm/icons/refresh-cw.mjs'
import ReplyIcon from 'lucide-react/dist/esm/icons/reply.mjs'
import SearchIcon from 'lucide-react/dist/esm/icons/search.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'
import SettingsIcon from 'lucide-react/dist/esm/icons/settings.mjs'
import TagIcon from 'lucide-react/dist/esm/icons/tag.mjs'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'
import { useTheme } from 'fumadocs-ui/provider/base'

import type { Message } from '@cloudflare-inbox/contracts/messages'
import type { MailboxSettings, PatchMailboxRequest } from '@cloudflare-inbox/contracts/mailboxes'
import type { SendResponse } from '@cloudflare-inbox/contracts/send'
import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'
import type { ThreadSummary } from '@cloudflare-inbox/contracts/threads'

import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Badge } from '#/components/ui/badge'
import { Button, buttonVariants } from '#/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { Separator } from '#/components/ui/separator'
import { Textarea } from '#/components/ui/textarea'
import { cn } from '#/lib/utils'

import {
  clampPaneSize,
  attachmentLimitError,
  defaultReplyRecipients,
  formatMessageTime,
  inboundReplyTargets,
  initials,
  messageDeliveryPresentation,
  participantLabel,
  replySubject,
  visibleRecipients,
} from './inbox-model'
import type { InboxData, InboxQuery, NewMessageDraft, ReplyDraft } from './inbox-types'

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>

const HydratedTimeContext = createContext(false)

const FOLDERS: readonly {
  id: ThreadFolder
  label: string
  icon: Icon
  countKey: 'all' | 'needsReply' | 'sent' | 'archive'
}[] = [
  { id: 'all', label: 'All', icon: InboxIcon, countKey: 'all' },
  { id: 'needs-reply', label: 'Needs reply', icon: ReplyIcon, countKey: 'needsReply' },
  { id: 'sent', label: 'Sent', icon: SendIcon, countKey: 'sent' },
  { id: 'archive', label: 'Archive', icon: ArchiveIcon, countKey: 'archive' },
]

type QueryChangeOptions = Readonly<{ replace?: boolean }>

type InboxShellProps = Readonly<{
  data: InboxData
  query: InboxQuery
  busy?: boolean
  refreshing?: boolean
  loadingMore?: boolean
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

export function InboxShell({
  data,
  query,
  busy = false,
  refreshing = false,
  loadingMore = false,
  error = null,
  onQueryChange,
  onSelectThread,
  onBack,
  onRefresh,
  onLoadMore,
  onArchiveThread,
  onReply,
  onCompose,
  onSignOut,
  onUpdateMailbox,
}: InboxShellProps) {
  const [localTimesReady, setLocalTimesReady] = useState(false)
  const [navigationCollapsed, setNavigationCollapsed] = useState(false)
  const [navigationWidth, setNavigationWidth] = useState(248)
  const [threadListWidth, setThreadListWidth] = useState(390)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const mailbox =
    data.mailboxes.find((item) => item.id === query.mailboxId) ?? data.mailboxes[0] ?? null
  const mobileDetailVisible = query.threadId !== null && data.selectedThread !== null
  const paneStyle = {
    '--navigation-width': `${navigationCollapsed ? 68 : navigationWidth}px`,
    '--thread-list-width': `${threadListWidth}px`,
  } as CSSProperties

  useEffect(() => setLocalTimesReady(true), [])

  return (
    <HydratedTimeContext.Provider value={localTimesReady}>
      <main className="relative h-dvh min-h-0 w-full overflow-hidden bg-background text-foreground">
        <div
          className="grid h-full min-h-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)] md:grid-cols-[minmax(280px,38%)_minmax(0,1fr)] md:grid-rows-[auto_auto_minmax(0,1fr)] xl:grid-cols-[var(--navigation-width)_5px_var(--thread-list-width)_5px_minmax(0,1fr)] xl:grid-rows-1"
          style={paneStyle}
        >
          <MailboxSidebar
            collapsed={navigationCollapsed}
            mailbox={mailbox}
            mailboxes={data.mailboxes}
            query={query}
            onCollapse={() => setNavigationCollapsed((current) => !current)}
            onOpenSettings={() => setSettingsOpen(true)}
            onQueryChange={onQueryChange}
            onSignOut={onSignOut}
          />
          <PaneResizeHandle
            className="hidden xl:block xl:col-start-2 xl:row-start-1"
            disabled={navigationCollapsed}
            label="Resize mailbox navigation"
            maximum={360}
            minimum={220}
            onChange={setNavigationWidth}
            value={navigationWidth}
          />

          <CompactHeader
            className={cn(
              'col-start-1 row-start-1 md:col-span-2 xl:hidden',
              mobileDetailVisible && 'hidden md:flex',
            )}
            mailbox={mailbox}
            mailboxes={data.mailboxes}
            query={query}
            onOpenSettings={() => setSettingsOpen(true)}
            onQueryChange={onQueryChange}
          />
          <MobileFolders
            className={cn(
              'col-start-1 row-start-2 md:col-span-2 xl:hidden',
              mobileDetailVisible && 'hidden md:flex',
            )}
            mailbox={mailbox}
            query={query}
            onQueryChange={onQueryChange}
          />

          <ThreadListPane
            className={cn(
              'col-start-1 row-start-3 md:col-start-1 md:row-start-3 xl:col-start-3 xl:row-start-1',
              mobileDetailVisible ? 'hidden md:flex' : 'flex',
            )}
            busy={busy}
            mailboxAddress={mailbox?.address ?? 'Inbox'}
            nextCursor={data.nextCursor}
            query={query}
            refreshing={refreshing}
            loadingMore={loadingMore}
            selectedThreadId={data.selectedThread?.thread.id ?? null}
            threads={data.threads}
            onQueryChange={onQueryChange}
            onCompose={() => setComposeOpen(true)}
            onLoadMore={onLoadMore}
            onRefresh={onRefresh}
            onSelectThread={onSelectThread}
          />
          <PaneResizeHandle
            className="hidden xl:block xl:col-start-4 xl:row-start-1"
            label="Resize conversation list"
            maximum={620}
            minimum={320}
            onChange={setThreadListWidth}
            value={threadListWidth}
          />

          <ConversationPane
            className={cn(
              'col-start-1 row-start-3 md:col-start-2 md:row-start-3 xl:col-start-5 xl:row-start-1',
              mobileDetailVisible ? 'flex' : 'hidden md:flex',
            )}
            busy={busy}
            detail={data.selectedThread}
            onArchiveThread={onArchiveThread}
            onBack={onBack}
            onReply={onReply}
          />
        </div>

        {error ? (
          <div
            className="absolute right-4 bottom-4 z-30 max-w-sm rounded-xl border border-destructive/30 bg-background px-4 py-3 text-sm text-foreground shadow-lg"
            role="alert"
          >
            {error}
          </div>
        ) : null}

        <MailboxSettingsDialog
          busy={busy}
          mailbox={mailbox}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSignOut={onSignOut}
          onUpdateMailbox={onUpdateMailbox}
        />
        <NewMessageDialog
          mailbox={mailbox}
          open={composeOpen}
          onCompose={onCompose}
          onOpenChange={setComposeOpen}
        />
      </main>
    </HydratedTimeContext.Provider>
  )
}

function BrandMark() {
  return (
    <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
      <MailOpenIcon aria-hidden="true" className="size-4" />
    </div>
  )
}

type TimePresentation = 'date' | 'full' | 'thread'

function HydratedTime({
  className,
  presentation,
  value,
}: Readonly<{ className?: string; presentation: TimePresentation; value: string }>) {
  const localTimesReady = useContext(HydratedTimeContext)

  return (
    <time className={className} dateTime={value} suppressHydrationWarning>
      {formatTime(value, presentation, localTimesReady)}
    </time>
  )
}

function formatTime(
  value: string,
  presentation: TimePresentation,
  localTimesReady: boolean,
): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value

  if (!localTimesReady) {
    const iso = date.toISOString()
    return presentation === 'full' ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : iso.slice(0, 10)
  }

  switch (presentation) {
    case 'thread':
      return formatMessageTime(value)
    case 'date':
      return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date)
    case 'full':
      return new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
  }
}

function MailboxSelect({
  className,
  mailboxes,
  query,
  onQueryChange,
}: Readonly<{
  className?: string
  mailboxes: InboxData['mailboxes']
  query: InboxQuery
  onQueryChange?: InboxShellProps['onQueryChange']
}>) {
  return (
    <select
      aria-label="Mailbox"
      className={cn(
        'h-8 min-w-0 rounded-lg border border-input bg-background px-2 text-sm font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        className,
      )}
      disabled={mailboxes.length === 0}
      onChange={(event) => void onQueryChange?.({ mailboxId: event.currentTarget.value })}
      value={query.mailboxId}
    >
      {mailboxes.length === 0 ? <option value="">No mailbox assigned</option> : null}
      {mailboxes.map((mailbox) => (
        <option key={mailbox.id} value={mailbox.id}>
          {mailbox.address}
        </option>
      ))}
    </select>
  )
}

function MailboxSidebar({
  collapsed,
  mailbox,
  mailboxes,
  query,
  onCollapse,
  onOpenSettings,
  onQueryChange,
  onSignOut,
}: Readonly<{
  collapsed: boolean
  mailbox: InboxData['mailboxes'][number] | null
  mailboxes: InboxData['mailboxes']
  query: InboxQuery
  onCollapse: () => void
  onOpenSettings: () => void
  onQueryChange?: InboxShellProps['onQueryChange']
  onSignOut?: InboxShellProps['onSignOut']
}>) {
  return (
    <aside className="hidden min-w-0 flex-col bg-sidebar text-sidebar-foreground xl:col-start-1 xl:row-start-1 xl:flex">
      <div
        className={cn(
          'flex h-14 items-center border-b px-3',
          collapsed ? 'justify-center' : 'gap-3',
        )}
      >
        <BrandMark />
        {collapsed ? null : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Simple Inbox</p>
            <p className="truncate text-xs text-muted-foreground">Private mail workspace</p>
          </div>
        )}
        <Button
          aria-label={collapsed ? 'Expand mailbox navigation' : 'Collapse mailbox navigation'}
          onClick={onCollapse}
          size="icon-sm"
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          variant="ghost"
        >
          {collapsed ? (
            <PanelLeftOpenIcon aria-hidden="true" className="size-4" />
          ) : (
            <PanelLeftCloseIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
      </div>

      {collapsed ? null : (
        <div className="p-3">
          <div className="rounded-xl border bg-background p-3 shadow-xs">
            <p className="text-xs font-medium text-muted-foreground">Mailbox</p>
            <MailboxSelect
              className="mt-2 w-full"
              mailboxes={mailboxes}
              query={query}
              onQueryChange={onQueryChange}
            />
            <p className="mt-2 truncate text-xs text-muted-foreground">
              Sending as {mailbox?.senderAlias ?? mailbox?.address ?? 'the configured mailbox'}
            </p>
          </div>
        </div>
      )}

      <FolderNavigation
        collapsed={collapsed}
        mailbox={mailbox}
        query={query}
        onQueryChange={onQueryChange}
      />

      <div className="space-y-1 border-t p-3">
        <a
          aria-label={collapsed ? 'Documentation' : undefined}
          className={cn(
            buttonVariants({ variant: 'ghost' }),
            'w-full',
            collapsed ? 'px-0' : 'justify-start',
          )}
          href="/docs"
          title={collapsed ? 'Documentation' : undefined}
        >
          <FileTextIcon aria-hidden="true" className="size-4" />
          {collapsed ? null : 'Documentation'}
        </a>
        <Button
          aria-label={collapsed ? 'Mailbox settings' : undefined}
          className={cn('w-full', collapsed ? 'px-0' : 'justify-start')}
          onClick={onOpenSettings}
          title={collapsed ? 'Mailbox settings' : undefined}
          variant="ghost"
        >
          <SettingsIcon aria-hidden="true" className="size-4" />
          {collapsed ? null : 'Settings'}
        </Button>
        <Button
          aria-label={collapsed ? 'Sign out' : undefined}
          className={cn('w-full', collapsed ? 'px-0' : 'justify-start')}
          onClick={() => void onSignOut?.()}
          title={collapsed ? 'Sign out' : undefined}
          variant="ghost"
        >
          <LogOutIcon aria-hidden="true" className="size-4" />
          {collapsed ? null : 'Sign out'}
        </Button>
      </div>
    </aside>
  )
}

function FolderNavigation({
  collapsed,
  mailbox,
  query,
  onQueryChange,
}: Readonly<{
  collapsed: boolean
  mailbox: InboxData['mailboxes'][number] | null
  query: InboxQuery
  onQueryChange?: InboxShellProps['onQueryChange']
}>) {
  return (
    <nav aria-label="Mailbox folders" className="flex-1 space-y-1 px-3">
      {FOLDERS.map((folder) => {
        const FolderIcon = folder.icon
        const count = mailbox?.counts[folder.countKey] ?? 0
        const active = query.folder === folder.id
        return (
          <Button
            aria-current={active ? 'page' : undefined}
            aria-label={collapsed ? `${folder.label}, ${count}` : undefined}
            className={cn(
              'h-9 w-full gap-2.5 px-3 text-sm',
              collapsed ? 'justify-center px-0' : 'justify-start',
              active && 'bg-sidebar-accent text-sidebar-accent-foreground',
            )}
            key={folder.id}
            onClick={() => void onQueryChange?.({ folder: folder.id })}
            title={collapsed ? folder.label : undefined}
            variant="ghost"
          >
            <FolderIcon aria-hidden="true" className="size-4" />
            {collapsed ? null : (
              <>
                <span className="flex-1 text-left">{folder.label}</span>
                <span className="tabular-nums text-xs text-muted-foreground">{count}</span>
              </>
            )}
          </Button>
        )
      })}
    </nav>
  )
}

function CompactHeader({
  className,
  mailbox,
  mailboxes,
  query,
  onOpenSettings,
  onQueryChange,
}: Readonly<{
  className?: string
  mailbox: InboxData['mailboxes'][number] | null
  mailboxes: InboxData['mailboxes']
  query: InboxQuery
  onOpenSettings: () => void
  onQueryChange?: InboxShellProps['onQueryChange']
}>) {
  return (
    <header className={cn('flex h-14 items-center gap-3 border-b px-3 sm:px-4', className)}>
      <BrandMark />
      <div className="min-w-0 flex-1">
        <p className="sr-only">Current mailbox</p>
        <MailboxSelect
          className="w-full max-w-xs"
          mailboxes={mailboxes}
          query={query}
          onQueryChange={onQueryChange}
        />
      </div>
      <span className="hidden max-w-40 truncate text-xs text-muted-foreground sm:block">
        {mailbox?.senderAlias ?? 'Default sender'}
      </span>
      <a className={buttonVariants({ size: 'sm', variant: 'ghost' })} href="/docs">
        Docs
      </a>
      <Button
        aria-label="Mailbox settings"
        onClick={onOpenSettings}
        size="icon-sm"
        title="Mailbox settings"
        variant="ghost"
      >
        <SettingsIcon aria-hidden="true" className="size-4" />
      </Button>
    </header>
  )
}

function MobileFolders({
  className,
  mailbox,
  query,
  onQueryChange,
}: Readonly<{
  className?: string
  mailbox: InboxData['mailboxes'][number] | null
  query: InboxQuery
  onQueryChange?: InboxShellProps['onQueryChange']
}>) {
  return (
    <nav
      aria-label="Mailbox folders"
      className={cn('flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-2', className)}
    >
      {FOLDERS.map((folder) => (
        <Button
          aria-current={query.folder === folder.id ? 'page' : undefined}
          className="shrink-0"
          key={folder.id}
          onClick={() => void onQueryChange?.({ folder: folder.id })}
          size="sm"
          variant={query.folder === folder.id ? 'secondary' : 'ghost'}
        >
          {folder.label}
          <span className="text-xs text-muted-foreground">
            {mailbox?.counts[folder.countKey] ?? 0}
          </span>
        </Button>
      ))}
    </nav>
  )
}

function ThreadListPane({
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
              disabled={busy || refreshing}
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
  disabled,
  onSelect,
  thread,
}: Readonly<{
  active: boolean
  disabled: boolean
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
      disabled={disabled}
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

function EmptyList({ title, description }: Readonly<{ title: string; description: string }>) {
  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center px-8 text-center">
      <InboxIcon aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-60 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

function ConversationPane({
  className,
  detail,
  busy,
  onBack,
  onArchiveThread,
  onReply,
}: Readonly<{
  className?: string
  detail: InboxData['selectedThread']
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
        className={cn(
          'min-w-0 flex-1 items-center justify-center bg-muted/20 p-8 text-center',
          className,
        )}
      >
        <div>
          <MailOpenIcon aria-hidden="true" className="mx-auto size-9 text-muted-foreground" />
          <h2 className="mt-3 text-sm font-semibold">Choose a conversation</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Messages and reply controls appear here.
          </p>
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
            <MessageCard key={message.id} message={message} />
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

function MessageCard({ message }: Readonly<{ message: Message }>) {
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
      <div className="whitespace-pre-wrap p-4 text-sm leading-6">
        {message.textBody || message.preview}
      </div>
      {message.attachments.length > 0 || message.rawAvailable ? (
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
            <a
              className={cn(buttonVariants({ size: 'sm', variant: 'ghost' }), 'ml-auto')}
              href={`/api/v1/messages/${encodeURIComponent(message.id)}/raw`}
            >
              <FileTextIcon aria-hidden="true" className="size-4" />
              Raw email
            </a>
          ) : null}
        </footer>
      ) : null}
    </article>
  )
}

type ReplyStatus = 'idle' | 'sending' | 'accepted' | 'uncertain' | 'error'

function ReplyComposer({
  detail,
  onCancel,
  onReply,
}: Readonly<{
  detail: NonNullable<InboxData['selectedThread']>
  onCancel: () => void
  onReply?: InboxShellProps['onReply']
}>) {
  const id = useId()
  const localTimesReady = useContext(HydratedTimeContext)
  const inboundTargets = inboundReplyTargets(detail.messages)
  const latestInbound = inboundTargets.at(-1)
  const [targetMessageId, setTargetMessageId] = useState(latestInbound?.id ?? '')
  const [to, setTo] = useState(latestInbound ? defaultReplyRecipients(latestInbound) : '')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCopies, setShowCopies] = useState(false)
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<readonly File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [status, setStatus] = useState<ReplyStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const uncertain = status === 'uncertain'
  const locked = status === 'sending' || uncertain

  function draftChanged(): void {
    if (status === 'accepted' || status === 'error') setIdempotencyKey(crypto.randomUUID())
    if (status !== 'sending' && status !== 'uncertain') {
      setStatus('idle')
      setStatusMessage('')
    }
  }

  function chooseReplyTarget(messageId: string): void {
    const message = inboundTargets.find((item) => item.id === messageId)
    setTargetMessageId(messageId)
    if (message !== undefined) setTo(defaultReplyRecipients(message))
    draftChanged()
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (locked || attachmentError || !body.trim() || !to.trim() || onReply === undefined) return
    setStatus('sending')
    setStatusMessage('Sending your reply…')
    try {
      const result = await onReply(detail.thread.id, {
        to,
        cc,
        bcc,
        subject: replySubject(detail.thread.subject),
        body,
        attachments,
        idempotencyKey,
        targetMessageId: targetMessageId || null,
      })
      if (result.state === 'unknown') {
        setStatus('uncertain')
        setStatusMessage(
          'Delivery status is unknown. Keep this draft and check the thread before resending.',
        )
        return
      }
      if (result.state === 'failed') {
        setIdempotencyKey(crypto.randomUUID())
        setStatus('error')
        setStatusMessage('The reply failed. Your draft is available for a new retry.')
        return
      }

      setStatus('accepted')
      setStatusMessage(
        result.state === 'sent' ? 'Reply sent.' : 'Reply accepted and still processing.',
      )
      setBody('')
      setAttachments([])
      setAttachmentError('')
      setIdempotencyKey(crypto.randomUUID())
    } catch {
      setStatus('error')
      setStatusMessage(
        'The reply was not accepted. Retrying unchanged content reuses the safe request key.',
      )
    }
  }

  return (
    <form
      className="rounded-xl border bg-background p-4 shadow-xs"
      onSubmit={(event) => void submit(event)}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Reply</h3>
          <p className="text-xs text-muted-foreground">
            Sending as this mailbox’s configured alias.
          </p>
        </div>
        <Button
          disabled={locked}
          onClick={() => setShowCopies((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cc / Bcc
        </Button>
      </div>
      <FieldGroup className="gap-3">
        {inboundTargets.length > 1 ? (
          <Field orientation="responsive">
            <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-target`}>
              Reply to
            </FieldLabel>
            <select
              className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              disabled={locked}
              id={`${id}-target`}
              onChange={(event) => chooseReplyTarget(event.currentTarget.value)}
              value={targetMessageId}
            >
              {inboundTargets.map((message) => (
                <option key={message.id} value={message.id}>
                  {message.from.displayName ?? message.from.address} ·{' '}
                  {formatTime(message.sentAt, 'date', localTimesReady)}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field orientation="responsive">
          <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-to`}>
            To
          </FieldLabel>
          <Input
            disabled={locked}
            id={`${id}-to`}
            onChange={(event) => {
              setTo(event.currentTarget.value)
              draftChanged()
            }}
            required
            value={to}
          />
        </Field>
        {showCopies ? (
          <>
            <Field orientation="responsive">
              <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-cc`}>
                Cc
              </FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-cc`}
                onChange={(event) => {
                  setCc(event.currentTarget.value)
                  draftChanged()
                }}
                value={cc}
              />
            </Field>
            <Field orientation="responsive">
              <FieldLabel className="w-24 shrink-0" htmlFor={`${id}-bcc`}>
                Bcc
              </FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-bcc`}
                onChange={(event) => {
                  setBcc(event.currentTarget.value)
                  draftChanged()
                }}
                value={bcc}
              />
            </Field>
          </>
        ) : null}
        <Field>
          <FieldLabel className="sr-only" htmlFor={`${id}-body`}>
            Message
          </FieldLabel>
          <Textarea
            className="min-h-32 resize-y"
            autoFocus
            disabled={locked}
            id={`${id}-body`}
            onChange={(event) => {
              setBody(event.currentTarget.value)
              draftChanged()
            }}
            placeholder="Write a reply… Markdown is supported."
            required
            value={body}
          />
        </Field>
        <Field>
          <FieldLabel className="sr-only" htmlFor={`${id}-attachments`}>
            Add attachments
          </FieldLabel>
          <Input
            disabled={locked}
            id={`${id}-attachments`}
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? [])
              if (files.length > 0) {
                const next = [...attachments, ...files]
                const limitError = attachmentLimitError(next)
                if (limitError === null) {
                  setAttachments(next)
                  setAttachmentError('')
                  draftChanged()
                } else {
                  setAttachmentError(limitError)
                }
              }
              event.currentTarget.value = ''
            }}
            type="file"
          />
        </Field>
      </FieldGroup>
      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="mt-3 space-y-1">
          {attachments.map((file, index) => (
            <li
              className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
              key={`${file.name}-${file.size}-${index}`}
            >
              <PaperclipIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <Button
                aria-label={`Remove ${file.name}`}
                disabled={locked}
                onClick={() => {
                  setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  setAttachmentError('')
                  draftChanged()
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          disabled={locked || Boolean(attachmentError) || !body.trim() || !to.trim()}
          type="submit"
        >
          <SendIcon aria-hidden="true" className="size-4" />
          {status === 'sending' ? 'Sending…' : 'Send reply'}
        </Button>
        <Button disabled={locked} onClick={onCancel} type="button" variant="ghost">
          Cancel
        </Button>
        <span
          aria-live="polite"
          className="ml-auto inline-flex max-w-sm items-center gap-1 text-right text-xs text-muted-foreground"
        >
          {status === 'accepted' ? (
            <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
          ) : null}
          {attachmentError || statusMessage}
        </span>
      </div>
    </form>
  )
}

function NewMessageDialog({
  mailbox,
  open,
  onCompose,
  onOpenChange,
}: Readonly<{
  mailbox: InboxData['mailboxes'][number] | null
  open: boolean
  onCompose?: InboxShellProps['onCompose']
  onOpenChange: (open: boolean) => void
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [attachments, setAttachments] = useState<readonly File[]>([])
  const [attachmentError, setAttachmentError] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [status, setStatus] = useState<ReplyStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const uncertain = status === 'uncertain'
  const locked = status === 'sending' || uncertain

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  function draftChanged(): void {
    if (status === 'accepted' || status === 'error') setIdempotencyKey(crypto.randomUUID())
    if (status !== 'sending' && status !== 'uncertain') {
      setStatus('idle')
      setStatusMessage('')
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (
      mailbox === null ||
      onCompose === undefined ||
      locked ||
      attachmentError ||
      !to.trim() ||
      !body.trim()
    ) {
      return
    }

    setStatus('sending')
    setStatusMessage('Sending your message…')
    try {
      const result = await onCompose(mailbox.id, {
        to,
        cc,
        bcc,
        subject,
        body,
        attachments,
        idempotencyKey,
      })
      if (result.state === 'unknown') {
        setStatus('uncertain')
        setStatusMessage(
          'Delivery status is unknown. The full draft is retained; check Sent before resending.',
        )
        return
      }
      if (result.state === 'failed') {
        setIdempotencyKey(crypto.randomUUID())
        setStatus('error')
        setStatusMessage('The message failed. The full draft is available for a new retry.')
        return
      }

      setStatus('accepted')
      setStatusMessage(
        result.state === 'sent' ? 'Message sent.' : 'Message accepted and still processing.',
      )
      setTo('')
      setCc('')
      setBcc('')
      setSubject('')
      setBody('')
      setAttachments([])
      setAttachmentError('')
      setIdempotencyKey(crypto.randomUUID())
    } catch {
      setStatus('error')
      setStatusMessage(
        'The message was not accepted. The full draft is retained and an unchanged retry reuses its request key.',
      )
    }
  }

  return (
    <dialog
      aria-describedby={`${id}-description`}
      aria-labelledby={`${id}-title`}
      className="m-auto max-h-[92dvh] w-[min(94vw,42rem)] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault()
        if (!locked) onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      ref={dialog}
    >
      <form
        className="max-h-[92dvh] overflow-y-auto p-5 sm:p-6"
        onSubmit={(event) => void submit(event)}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold" id={`${id}-title`}>
              New message
            </h2>
            <p className="mt-1 text-sm text-muted-foreground" id={`${id}-description`}>
              Sending as {mailbox?.senderAlias ?? mailbox?.address ?? 'the selected mailbox'}.
            </p>
          </div>
          <Button
            aria-label="Close new message"
            disabled={locked}
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <FieldGroup className="mt-5 gap-3">
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-to`}>
              To
            </FieldLabel>
            <Input
              autoFocus
              disabled={locked}
              id={`${id}-to`}
              onChange={(event) => {
                setTo(event.currentTarget.value)
                draftChanged()
              }}
              placeholder="recipient@example.com"
              required
              value={to}
            />
          </Field>
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-cc`}>
              Cc
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-cc`}
              onChange={(event) => {
                setCc(event.currentTarget.value)
                draftChanged()
              }}
              value={cc}
            />
          </Field>
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-bcc`}>
              Bcc
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-bcc`}
              onChange={(event) => {
                setBcc(event.currentTarget.value)
                draftChanged()
              }}
              value={bcc}
            />
          </Field>
          <Field orientation="responsive">
            <FieldLabel className="w-16 shrink-0" htmlFor={`${id}-subject`}>
              Subject
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-subject`}
              maxLength={998}
              onChange={(event) => {
                setSubject(event.currentTarget.value)
                draftChanged()
              }}
              value={subject}
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor={`${id}-body`}>
              Message
            </FieldLabel>
            <Textarea
              className="min-h-48 resize-y"
              disabled={locked}
              id={`${id}-body`}
              onChange={(event) => {
                setBody(event.currentTarget.value)
                draftChanged()
              }}
              placeholder="Write a message… Markdown is supported."
              required
              value={body}
            />
          </Field>
          <Field>
            <FieldLabel className="sr-only" htmlFor={`${id}-attachments`}>
              Add attachments
            </FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-attachments`}
              multiple
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? [])
                if (files.length > 0) {
                  const next = [...attachments, ...files]
                  const limitError = attachmentLimitError(next)
                  if (limitError === null) {
                    setAttachments(next)
                    setAttachmentError('')
                    draftChanged()
                  } else {
                    setAttachmentError(limitError)
                  }
                }
                event.currentTarget.value = ''
              }}
              type="file"
            />
          </Field>
        </FieldGroup>

        {attachments.length > 0 ? (
          <ul aria-label="Attachments" className="mt-3 space-y-1">
            {attachments.map((file, index) => (
              <li
                className="flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs"
                key={`${file.name}-${file.size}-${index}`}
              >
                <PaperclipIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <Button
                  aria-label={`Remove ${file.name}`}
                  disabled={locked}
                  onClick={() => {
                    setAttachments((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                    setAttachmentError('')
                    draftChanged()
                  }}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon aria-hidden="true" className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button
            disabled={
              mailbox === null || locked || Boolean(attachmentError) || !to.trim() || !body.trim()
            }
            type="submit"
          >
            <SendIcon aria-hidden="true" className="size-4" />
            {status === 'sending' ? 'Sending…' : 'Send message'}
          </Button>
          <Button
            disabled={locked}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Close
          </Button>
          <span
            aria-live="polite"
            className="ml-auto inline-flex max-w-sm items-center gap-1 text-right text-xs text-muted-foreground"
          >
            {status === 'accepted' ? (
              <CheckCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
            ) : null}
            {attachmentError || statusMessage}
          </span>
        </div>
      </form>
    </dialog>
  )
}

function MailboxSettingsDialog({
  busy,
  mailbox,
  open,
  onOpenChange,
  onSignOut,
  onUpdateMailbox,
}: Readonly<{
  busy: boolean
  mailbox: InboxData['mailboxes'][number] | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSignOut?: InboxShellProps['onSignOut']
  onUpdateMailbox?: InboxShellProps['onUpdateMailbox']
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const draftMailboxId = useRef(mailbox?.id ?? null)
  const preserveOpenDraft = useRef(false)
  const id = useId()
  const [alias, setAlias] = useState(mailbox?.senderAlias ?? '')
  const [forwardTo, setForwardTo] = useState(mailbox?.forwardTo ?? '')
  const [forwardToEdited, setForwardToEdited] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const { setTheme, theme } = useTheme()
  const selectedTheme = theme === 'light' || theme === 'dark' ? theme : 'system'

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  useEffect(() => {
    if (!open) {
      preserveOpenDraft.current = false
      return
    }
    const mailboxId = mailbox?.id ?? null
    const mailboxChanged = draftMailboxId.current !== mailboxId
    if (!mailboxChanged && preserveOpenDraft.current) return
    draftMailboxId.current = mailboxId
    preserveOpenDraft.current = false
    setAlias(mailbox?.senderAlias ?? '')
    setForwardTo(mailbox?.forwardTo ?? '')
    setForwardToEdited(false)
    setStatus('idle')
  }, [mailbox?.forwardTo, mailbox?.id, mailbox?.senderAlias, open])

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (mailbox === null || onUpdateMailbox === undefined) return
    const senderAlias = alias.trim() || null
    const patch: PatchMailboxRequest = {
      ...(senderAlias === mailbox.senderAlias ? {} : { senderAlias }),
      ...(forwardToEdited ? { forwardTo: forwardTo.trim() || null } : {}),
    }
    if (patch.senderAlias === undefined && patch.forwardTo === undefined) {
      preserveOpenDraft.current = true
      setStatus('saved')
      return
    }
    // Parent state may publish the saved mailbox before this promise resumes.
    // Preserve this open dialog's status/draft across that same-mailbox update;
    // closing the dialog clears the guard so the next open uses fresh props.
    preserveOpenDraft.current = true
    setStatus('saving')
    try {
      const saved = await onUpdateMailbox(mailbox.id, patch)
      setAlias(saved.senderAlias ?? '')
      setForwardTo(saved.forwardTo ?? '')
      setForwardToEdited(false)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  return (
    <dialog
      aria-describedby={`${id}-description`}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(92vw,30rem)] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault()
        onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      ref={dialog}
    >
      <form className="p-5 sm:p-6" onSubmit={(event) => void save(event)}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold" id={`${id}-title`}>
              Mailbox settings
            </h2>
            <p className="mt-1 text-sm text-muted-foreground" id={`${id}-description`}>
              Update the outbound sender name and inbound forwarding destination for this mailbox.
            </p>
          </div>
          <Button
            aria-label="Close settings"
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <Field className="mt-5">
          <FieldLabel htmlFor={`${id}-alias`}>Sender alias</FieldLabel>
          <Input
            autoFocus
            disabled={busy || mailbox === null}
            id={`${id}-alias`}
            maxLength={200}
            onChange={(event) => {
              setAlias(event.currentTarget.value)
              setStatus('idle')
            }}
            placeholder={mailbox?.address ?? 'Mailbox sender'}
            value={alias}
          />
          <p className="text-xs text-muted-foreground">
            Mailbox: {mailbox?.address ?? 'No mailbox assigned'}
          </p>
        </Field>

        <Field className="mt-4">
          <FieldLabel htmlFor={`${id}-forward-to`}>Forward inbound mail to</FieldLabel>
          <Input
            autoComplete="email"
            disabled={busy || mailbox === null}
            id={`${id}-forward-to`}
            inputMode="email"
            maxLength={254}
            onChange={(event) => {
              setForwardTo(event.currentTarget.value)
              setForwardToEdited(true)
              setStatus('idle')
            }}
            placeholder="owner@example.com"
            type="email"
            value={forwardTo}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {forwardToEdited
                ? 'This destination will be updated when you save.'
                : 'The current forwarding destination will remain unchanged.'}
            </span>
            {forwardToEdited ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setForwardTo(mailbox?.forwardTo ?? '')
                  setForwardToEdited(false)
                  setStatus('idle')
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Keep current
              </Button>
            ) : null}
            {mailbox?.forwardTo !== null ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setForwardTo('')
                  setForwardToEdited(true)
                  setStatus('idle')
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Clear forwarding
              </Button>
            ) : null}
          </div>
        </Field>

        <Field className="mt-4">
          <FieldLabel htmlFor={`${id}-theme`}>Color theme</FieldLabel>
          <select
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            id={`${id}-theme`}
            onChange={(event) => setTheme(event.currentTarget.value)}
            value={selectedTheme}
          >
            <option value="system">Use system setting</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <p className="text-xs text-muted-foreground">
            Your preference is kept in this browser for the inbox and documentation.
          </p>
        </Field>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button disabled={busy || mailbox === null || status === 'saving'} type="submit">
            {status === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            className="ml-auto"
            disabled={busy}
            onClick={() => void onSignOut?.()}
            type="button"
            variant="ghost"
          >
            <LogOutIcon aria-hidden="true" className="size-4" />
            Sign out
          </Button>
          <span aria-live="polite" className="w-full text-xs text-muted-foreground">
            {status === 'saved' ? 'Sender alias saved.' : null}
            {status === 'error' ? 'Settings could not be saved.' : null}
          </span>
        </div>
      </form>
    </dialog>
  )
}

function PaneResizeHandle({
  className,
  disabled = false,
  label,
  maximum,
  minimum,
  onChange,
  value,
}: Readonly<{
  className?: string
  disabled?: boolean
  label: string
  maximum: number
  minimum: number
  onChange: (value: number) => void
  value: number
}>) {
  const drag = useRef<{ pointerId: number; start: number; value: number } | null>(null)

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled) return
    drag.current = { pointerId: event.pointerId, start: event.clientX, value }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return
    onChange(
      clampPaneSize(drag.current.value + event.clientX - drag.current.start, minimum, maximum),
    )
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (disabled) return
    let next = value
    if (event.key === 'ArrowLeft') next -= 16
    else if (event.key === 'ArrowRight') next += 16
    else if (event.key === 'Home') next = minimum
    else if (event.key === 'End') next = maximum
    else return
    event.preventDefault()
    onChange(clampPaneSize(next, minimum, maximum))
  }

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={value}
      className={cn(
        'relative z-10 cursor-col-resize bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:w-3 hover:bg-primary focus-visible:bg-primary',
        disabled && 'cursor-default opacity-50',
        className,
      )}
      onKeyDown={keyDown}
      onPointerCancel={pointerUp}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      role="separator"
      tabIndex={disabled ? -1 : 0}
    />
  )
}

export function InboxStatusLegend() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <TagIcon aria-hidden="true" className="size-3" />
        Needs reply
      </span>
      <span className="inline-flex items-center gap-1">
        <ClockIcon aria-hidden="true" className="size-3" />
        Waiting
      </span>
    </div>
  )
}
