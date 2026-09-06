import { getRequest, setResponseHeader } from '@tanstack/react-start/server'

import {
  AuthenticatedSessionResponseSchema,
  SessionResponseSchema,
} from '@cloudflare-inbox/contracts/auth'
import type { MagicLinkVerifyRequest } from '@cloudflare-inbox/contracts/auth'
import { MailboxListResponseSchema } from '@cloudflare-inbox/contracts/mailboxes'
import { ThreadListResponseSchema } from '@cloudflare-inbox/contracts/threads'

import { canonicalInboxSearch } from './inbox-search'
import type { InboxSearch } from './inbox-search'
import { inboxReturnPath, readReturnPathCookie, returnPathCookie } from './inbox-return-path'
import type { InboxServerResult } from './inbox-server'
import { fetchInternalApi } from '#/internal-services.server'

class ServerApiError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`API request failed (${status})`)
    this.name = 'ServerApiError'
    this.status = status
  }
}

type AuthState = Awaited<ReturnType<typeof readSession>>

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const incoming = getRequest()
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')
  const cookie = incoming.headers.get('cookie')
  if (cookie !== null) headers.set('cookie', cookie)

  if ((incoming as Request & { readonly cf?: unknown }).cf !== undefined) {
    const sourceAddress = incoming.headers.get('cf-connecting-ip')
    if (sourceAddress !== null) headers.set('cf-connecting-ip', sourceAddress)
  }

  const retargeted = new Request(
    new URL(path, 'https://api.internal'),
    incoming as unknown as RequestInit,
  )
  return fetchInternalApi(new Request(retargeted, { ...init, headers, signal: incoming.signal }))
}

async function apiJson<TResult>(
  path: string,
  schema: { parse(input: unknown): TResult },
  init?: RequestInit,
): Promise<TResult> {
  const response = await apiFetch(path, init)
  if (!response.ok) throw new ServerApiError(response.status)
  return schema.parse(await response.json())
}

async function readSession() {
  return apiJson('/v1/auth/session', SessionResponseSchema)
}

function noStore(): void {
  setResponseHeader('cache-control', 'private, no-store')
  setResponseHeader('vary', 'Cookie')
}

export async function readServerAuthState(): Promise<boolean> {
  noStore()
  return (await readSession()).authenticated
}

export async function consumeMagicLink(
  data: MagicLinkVerifyRequest,
): Promise<
  Readonly<{ status: 'invalid' | 'retryable' }> | Readonly<{ returnTo: string; status: 'verified' }>
> {
  noStore()
  setResponseHeader('referrer-policy', 'no-referrer')

  let response: Response
  try {
    response = await apiFetch('/v1/auth/magic-links/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch {
    return { status: 'retryable' }
  }

  if (!response.ok) return { status: response.status === 400 ? 'invalid' : 'retryable' }
  try {
    AuthenticatedSessionResponseSchema.parse(await response.clone().json())
  } catch {
    return { status: 'retryable' }
  }

  const incoming = getRequest()
  const returnTo = readReturnPathCookie(incoming.headers.get('cookie')) ?? '/inbox?folder=all'
  setResponseHeader('set-cookie', [
    ...response.headers.getSetCookie(),
    returnPathCookie('', 0, new URL(incoming.url).protocol === 'https:'),
  ])
  return { returnTo, status: 'verified' }
}

export async function loadProtectedInbox(search: InboxSearch): Promise<InboxServerResult> {
  noStore()

  const [sessionResult, mailboxResult] = await Promise.allSettled([
    readSession(),
    apiJson('/v1/mailboxes', MailboxListResponseSchema),
  ])

  if (sessionResult.status === 'rejected') throw sessionResult.reason
  const session: AuthState = sessionResult.value
  if (!session.authenticated) {
    rememberReturnPath(search)
    return { status: 'anonymous' }
  }

  if (mailboxResult.status === 'rejected') {
    if (mailboxResult.reason instanceof ServerApiError && mailboxResult.reason.status === 401) {
      rememberReturnPath(search)
      return { status: 'anonymous' }
    }
    throw mailboxResult.reason
  }

  const mailboxes = mailboxResult.value.mailboxes
  const effectiveMailboxId =
    mailboxes.find((mailbox) => mailbox.id === search.mailbox)?.id ?? mailboxes[0]?.id ?? ''

  if (!effectiveMailboxId) {
    return {
      status: 'ready',
      data: { mailboxes, threads: [], selectedThread: null, nextCursor: null },
      effectiveMailboxId,
      search: canonicalInboxSearch(search, effectiveMailboxId, false),
    }
  }

  const query = new URLSearchParams({
    mailboxId: effectiveMailboxId,
    folder: search.folder,
    limit: '50',
  })
  if (search.unread === '1') query.set('unread', '1')
  if (search.q !== undefined) query.set('q', search.q)

  const threadPage = await apiJson(`/v1/threads?${query.toString()}`, ThreadListResponseSchema)

  return {
    status: 'ready',
    data: {
      mailboxes,
      threads: threadPage.items,
      selectedThread: null,
      nextCursor: threadPage.nextCursor,
    },
    effectiveMailboxId,
    search: canonicalInboxSearch(search, effectiveMailboxId, true),
  }
}

function rememberReturnPath(search: InboxSearch): void {
  const incoming = getRequest()
  setResponseHeader(
    'set-cookie',
    returnPathCookie(inboxReturnPath(search), 15 * 60, new URL(incoming.url).protocol === 'https:'),
  )
}
