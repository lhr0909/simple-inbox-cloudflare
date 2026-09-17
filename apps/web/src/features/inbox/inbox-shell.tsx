import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { cn } from '#/lib/utils'

import { HydratedTimeContext, PaneResizeHandle } from './inbox-primitives'
import { MailboxSidebar, CompactHeader, MobileFolders } from './mailbox-navigation'
import { ThreadListPane } from './thread-list-pane'
import { ConversationPane } from './conversation-pane'
import { NewMessageDialog } from './new-message-dialog'
import { AliasDialog } from './alias-dialog'
import { Button } from '#/components/ui/button'
import { MailboxSettingsDialog } from './mailbox-settings-dialog'
import { GeneralSettingsDialog } from './general-settings-dialog'
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
  onMessageState,
  onSpam,
  onBlockMailbox,
  onSpamRulesChange,
  onReply,
  onCompose,
  onSignOut,
  onUpdateMailbox,
  onCreateMailbox,
}: InboxShellProps) {
  const [localTimesReady, setLocalTimesReady] = useState(false)
  const [navigationCollapsed, setNavigationCollapsed] = useState(false)
  const [navigationWidth, setNavigationWidth] = useState(248)
  const [threadListWidth, setThreadListWidth] = useState(390)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsMailboxId, setSettingsMailboxId] = useState<string | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const [aliasOpen, setAliasOpen] = useState(false)
  const mailbox = data.mailboxes.find((item) => item.id === query.mailboxId) ?? null
  const [newMailboxAddress, setNewMailboxAddress] = useState('')
  const baseMailbox = data.mailboxes[0]
  const navigationMailbox =
    mailbox ??
    (baseMailbox
      ? {
          ...baseMailbox,
          counts: data.mailboxes
            .filter((item) => !item.whitelisted || item.blocked)
            .reduce(
              (counts, item) => {
                for (const key of Object.keys(counts) as (keyof typeof counts)[])
                  counts[key] += item.counts[key]
                return counts
              },
              { all: 0, inbox: 0, archive: 0, starred: 0, sent: 0, spam: 0, trash: 0, unread: 0 },
            ),
        }
      : null)
  const detailMailbox =
    data.mailboxes.find((item) => item.id === data.selectedThread?.thread.mailboxId) ?? mailbox
  const navigateMailbox: InboxShellProps['onQueryChange'] = (update, options) => {
    if (update.mailboxId === 'create') {
      setNewMailboxAddress('')
      setAliasOpen(true)
      return
    }
    return onQueryChange?.(update, options)
  }
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
            mailbox={navigationMailbox}
            mailboxes={data.mailboxes}
            query={query}
            onCollapse={() => setNavigationCollapsed((current) => !current)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMailboxSettings={() => setSettingsMailboxId(mailbox?.id ?? null)}
            onQueryChange={navigateMailbox}
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
            mailboxes={data.mailboxes}
            query={query}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenMailboxSettings={() => setSettingsMailboxId(mailbox?.id ?? null)}
            onQueryChange={navigateMailbox}
          />
          <MobileFolders
            className={cn(
              'col-start-1 row-start-2 md:col-span-2 xl:hidden',
              mobileDetailVisible && 'hidden md:flex',
            )}
            mailbox={navigationMailbox}
            query={query}
            onQueryChange={navigateMailbox}
          />

          <ThreadListPane
            className={cn(
              'col-start-1 row-start-3 md:col-start-1 md:row-start-3 xl:col-start-3 xl:row-start-1',
              mobileDetailVisible ? 'hidden md:flex' : 'flex',
            )}
            busy={busy}
            aliasAddresses={Object.fromEntries(
              data.mailboxes.map((item) => [item.id, item.address]),
            )}
            mailboxAddress={mailbox?.address ?? 'Other inbound'}
            nextCursor={data.nextCursor}
            query={query}
            refreshing={refreshing}
            loadingMore={loadingMore}
            selectedThreadId={query.threadId}
            threads={data.threads}
            onQueryChange={navigateMailbox}
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
            key={`${query.mailboxId}:${query.folder}:${query.threadId ?? ''}`}
            className={cn(
              'col-start-1 row-start-3 md:col-start-2 md:row-start-3 xl:col-start-5 xl:row-start-1',
              mobileDetailVisible ? 'flex' : 'hidden md:flex',
            )}
            busy={busy}
            detail={data.selectedThread}
            renderHtml={detailMailbox?.renderHtml ?? false}
            loading={detailLoading}
            error={detailError}
            onRetry={onRetryThread}
            onArchiveThread={onArchiveThread}
            onMessageState={onMessageState}
            onSpam={onSpam}
            onBack={onBack}
            onReply={onReply}
            aliasNotice={
              detailMailbox ? (
                <div className="flex flex-wrap items-center gap-2 border-b bg-background px-4 py-2 text-xs">
                  <span className="min-w-0 grow basis-full break-all sm:basis-56">
                    Received at {detailMailbox.address}
                    {detailMailbox.blocked
                      ? ' · blocked'
                      : !detailMailbox.whitelisted
                        ? ' · forwarding off'
                        : null}
                  </span>
                  {!detailMailbox.whitelisted || detailMailbox.blocked ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setSettingsMailboxId(detailMailbox.id)}
                    >
                      Mailbox settings
                    </Button>
                  ) : null}
                  {!detailMailbox.whitelisted && !detailMailbox.blocked ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setNewMailboxAddress(detailMailbox.address)
                        setAliasOpen(true)
                      }}
                    >
                      Create inbox for this mailbox
                    </Button>
                  ) : null}
                </div>
              ) : null
            }
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

        <AliasDialog
          initialAddress={newMailboxAddress}
          open={aliasOpen}
          onOpenChange={setAliasOpen}
          onCreateMailbox={onCreateMailbox}
        />
        <MailboxSettingsDialog
          busy={busy}
          mailbox={data.mailboxes.find((item) => item.id === settingsMailboxId) ?? null}
          open={settingsMailboxId !== null}
          onOpenChange={(open) => {
            if (!open) setSettingsMailboxId(null)
          }}
          onBlockMailbox={onBlockMailbox}
          onUpdateMailbox={onUpdateMailbox}
        />
        <GeneralSettingsDialog
          onSpamRulesChange={onSpamRulesChange}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          onSignOut={onSignOut}
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
