import type { ComponentType, SVGProps } from 'react'
import ArchiveIcon from 'lucide-react/dist/esm/icons/archive.mjs'
import FileTextIcon from 'lucide-react/dist/esm/icons/file-text.mjs'
import InboxIcon from 'lucide-react/dist/esm/icons/inbox.mjs'
import LogOutIcon from 'lucide-react/dist/esm/icons/log-out.mjs'
import PanelLeftCloseIcon from 'lucide-react/dist/esm/icons/panel-left-close.mjs'
import PanelLeftOpenIcon from 'lucide-react/dist/esm/icons/panel-left-open.mjs'
import ReplyIcon from 'lucide-react/dist/esm/icons/reply.mjs'
import SendIcon from 'lucide-react/dist/esm/icons/send.mjs'
import SettingsIcon from 'lucide-react/dist/esm/icons/settings.mjs'

import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'

import { Button, buttonVariants } from '#/components/ui/button'
import { cn } from '#/lib/utils'

import type { InboxData, InboxQuery } from './inbox-types'

import { BrandMark } from './inbox-primitives'
import type { InboxShellProps } from './inbox-shell-types'

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>

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

export function MailboxSidebar({
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

export function CompactHeader({
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

export function MobileFolders({
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
