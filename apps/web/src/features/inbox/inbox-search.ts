import { ThreadFolderSchema } from '@cloudflare-inbox/contracts/folders'
import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'
import { MailboxIdSchema, ThreadIdSchema } from '@cloudflare-inbox/contracts/ids'
import { SearchQuerySchema } from '@cloudflare-inbox/contracts/queries'

import type { InboxQuery } from './inbox-types'

export type InboxSearch = Readonly<{
  mailbox?: string
  folder: ThreadFolder
  unread?: '1'
  q?: string
  thread?: string
}>

type SearchRecord = Readonly<Record<string, unknown>>

function searchRecord(input: unknown): SearchRecord {
  return typeof input === 'object' && input !== null ? (input as SearchRecord) : {}
}

function parsedValue<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
) {
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

/**
 * TanStack search validation is intentionally forgiving: malformed values are
 * replaced with safe defaults instead of turning a stale bookmark into an
 * error page. The API validates the normalized query again at its boundary.
 */
export function parseInboxSearch(input: unknown): InboxSearch {
  const record = searchRecord(input)
  const mailbox = parsedValue(MailboxIdSchema, record['mailbox'])
  const folder = parsedValue(ThreadFolderSchema, record['folder']) ?? 'all'
  const query = parsedValue(SearchQuerySchema, record['q'])
  const thread = parsedValue(ThreadIdSchema, record['thread'])

  return {
    folder,
    ...(mailbox === undefined ? {} : { mailbox }),
    ...(record['unread'] === '1' ? { unread: '1' as const } : {}),
    ...(query === undefined ? {} : { q: query }),
    ...(thread === undefined ? {} : { thread }),
  }
}

export function inboxQueryFromSearch(search: InboxSearch, effectiveMailboxId: string): InboxQuery {
  return {
    mailboxId: effectiveMailboxId,
    folder: search.folder,
    unreadOnly: search.unread === '1',
    search: search.q ?? '',
    threadId: search.thread ?? null,
  }
}

export function inboxSearchKey(search: InboxSearch): string {
  return [
    search.mailbox ?? '',
    search.folder,
    search.unread ?? '',
    search.q ?? '',
    search.thread ?? '',
  ].join('\u0000')
}

export function inboxListSearchKey(search: InboxSearch): string {
  return [search.mailbox ?? '', search.folder, search.unread ?? '', search.q ?? ''].join('\u0000')
}

export function updateInboxSearch(search: InboxSearch, update: Partial<InboxQuery>): InboxSearch {
  let mailbox = search.mailbox
  let folder = search.folder
  let unread = search.unread
  let query = search.q
  let thread = search.thread
  let resetThread = false

  if (update.mailboxId !== undefined && update.mailboxId !== mailbox) {
    mailbox = update.mailboxId || undefined
    resetThread = true
  }
  if (update.folder !== undefined && update.folder !== folder) {
    folder = update.folder
    resetThread = true
  }
  if (update.unreadOnly !== undefined) {
    const nextUnread = update.unreadOnly ? ('1' as const) : undefined
    if (nextUnread !== unread) resetThread = true
    unread = nextUnread
  }
  if (update.search !== undefined) {
    const nextQuery = parsedValue(SearchQuerySchema, update.search.trim())
    if (nextQuery !== query) resetThread = true
    query = nextQuery
  }
  if (update.threadId !== undefined) thread = update.threadId ?? undefined
  if (resetThread && update.threadId === undefined) thread = undefined

  return {
    folder,
    ...(mailbox === undefined ? {} : { mailbox }),
    ...(unread === undefined ? {} : { unread }),
    ...(query === undefined ? {} : { q: query }),
    ...(thread === undefined ? {} : { thread }),
  }
}

export function canonicalInboxSearch(
  search: InboxSearch,
  effectiveMailboxId: string,
  selectedThreadAvailable: boolean,
): InboxSearch {
  return {
    folder: search.folder,
    ...(effectiveMailboxId ? { mailbox: effectiveMailboxId } : {}),
    ...(search.unread === undefined ? {} : { unread: search.unread }),
    ...(search.q === undefined ? {} : { q: search.q }),
    ...(search.thread === undefined || !selectedThreadAvailable ? {} : { thread: search.thread }),
  }
}

export function sameInboxSearch(left: InboxSearch, right: InboxSearch): boolean {
  return inboxSearchKey(left) === inboxSearchKey(right)
}
