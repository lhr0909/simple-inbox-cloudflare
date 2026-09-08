import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { cn } from '#/lib/utils'

import { HydratedTimeContext, PaneResizeHandle } from './inbox-primitives'
import { MailboxSidebar, CompactHeader, MobileFolders } from './mailbox-navigation'
import { ThreadListPane } from './thread-list-pane'
import { ConversationPane } from './conversation-pane'
import { NewMessageDialog } from './new-message-dialog'
import { MailboxSettingsDialog } from './mailbox-settings-dialog'
import type { InboxShellProps } from './inbox-shell-types'

export function InboxShell({
  data,
  query,
  busy = false,
  refreshing = false,
  loadingMore = false,
  detailLoading = false,
  detailError = null,
  onRetryThread,
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
  const mobileDetailVisible = query.threadId !== null
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
            selectedThreadId={query.threadId}
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
            renderHtml={mailbox?.renderHtml ?? false}
            loading={detailLoading}
            error={detailError}
            onRetry={onRetryThread}
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

export { InboxStatusLegend } from './inbox-primitives'
