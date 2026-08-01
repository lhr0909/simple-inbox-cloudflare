import { AttachmentIdSchema, MessageIdSchema } from '@cloudflare-inbox/contracts/ids'

import { parseInboxSearch } from './inbox-search'
import type { InboxSearch } from './inbox-search'

export const RETURN_PATH_COOKIE = 'cloudflare_inbox_return'

export function returnPathCookie(value: string, maxAge: number, secure: boolean): string {
  return `${RETURN_PATH_COOKIE}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

export function readReturnPathCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) return null
  for (const pair of cookieHeader.split(';')) {
    const [name, ...parts] = pair.trim().split('=')
    if (name !== RETURN_PATH_COOKIE) continue
    try {
      return safeReturnPath(decodeURIComponent(parts.join('=')))
    } catch {
      return null
    }
  }
  return null
}

export function unauthorizedNavigationReturnPath(request: Request): string | null {
  if (request.method !== 'GET') return null
  const destination = request.headers.get('sec-fetch-dest')
  const mode = request.headers.get('sec-fetch-mode')
  if (destination !== 'document' && mode !== 'navigate') return null
  const url = new URL(request.url)
  return safeReturnPath(`${url.pathname}${url.search}`)
}

export function inboxReturnPath(search: InboxSearch): string {
  const query = new URLSearchParams({ folder: search.folder })
  if (search.mailbox !== undefined) query.set('mailbox', search.mailbox)
  if (search.unread !== undefined) query.set('unread', search.unread)
  if (search.q !== undefined) query.set('q', search.q)
  if (search.thread !== undefined) query.set('thread', search.thread)
  return `/inbox?${query.toString()}`
}

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null

  let url: URL
  try {
    url = new URL(value, 'https://return.invalid')
  } catch {
    return null
  }

  if (url.origin !== 'https://return.invalid' || url.hash) return null
  if (url.pathname === '/inbox') {
    return inboxReturnPath(parseInboxSearch(Object.fromEntries(url.searchParams)))
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (
    segments.length === 5 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'messages' &&
    MessageIdSchema.safeParse(segments[3]).success &&
    segments[4] === 'raw'
  ) {
    return url.pathname
  }
  if (
    segments.length === 6 &&
    segments[0] === 'api' &&
    segments[1] === 'v1' &&
    segments[2] === 'messages' &&
    MessageIdSchema.safeParse(segments[3]).success &&
    segments[4] === 'attachments' &&
    AttachmentIdSchema.safeParse(segments[5]).success
  ) {
    return url.pathname
  }
  return null
}
