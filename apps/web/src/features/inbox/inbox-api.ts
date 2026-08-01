import { MagicLinkAcceptedResponseSchema } from '@cloudflare-inbox/contracts/auth'
import { MailboxSettingsSchema } from '@cloudflare-inbox/contracts/mailboxes'
import type { PatchMailboxRequest } from '@cloudflare-inbox/contracts/mailboxes'
import { SendResponseSchema } from '@cloudflare-inbox/contracts/send'
import { ThreadListResponseSchema } from '@cloudflare-inbox/contracts/threads'

import type { InboxQuery, NewMessageDraft, ReplyDraft } from './inbox-types'

export class ApiRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

async function requestJson<TResult>(
  path: string,
  schema: { parse(input: unknown): TResult },
  init?: RequestInit,
): Promise<TResult> {
  const headers = new Headers(init?.headers)
  headers.set('accept', 'application/json')

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  })

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      message = body.error?.message ?? message
    } catch {
      // The public API may intentionally return an empty or binary error body.
    }
    throw new ApiRequestError(response.status, message)
  }

  return schema.parse(await response.json())
}

async function requestEmpty(path: string, init: RequestInit): Promise<void> {
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json')

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers,
  })
  if (!response.ok) throw new ApiRequestError(response.status, 'The update could not be saved.')
}

export function requestMagicLink(email: string) {
  return requestJson('/api/v1/auth/magic-links', MagicLinkAcceptedResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

export function markThreadRead(threadId: string) {
  return requestEmpty(`/api/v1/threads/${encodeURIComponent(threadId)}/read`, {
    method: 'POST',
  })
}

export function setThreadArchived(threadId: string, archived: boolean) {
  return requestEmpty(`/api/v1/threads/${encodeURIComponent(threadId)}/archive`, {
    method: archived ? 'POST' : 'DELETE',
  })
}

export function updateMailboxSettings(mailboxId: string, patch: PatchMailboxRequest) {
  return requestJson(`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}`, MailboxSettingsSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export function signOut() {
  return requestEmpty('/api/v1/auth/logout', { method: 'POST' })
}

export function listThreadPage(query: InboxQuery, cursor: string, signal?: AbortSignal) {
  const search = new URLSearchParams({
    mailboxId: query.mailboxId,
    folder: query.folder,
    unread: query.unreadOnly ? '1' : '0',
    limit: '50',
    cursor,
  })
  if (query.search.trim()) search.set('q', query.search.trim())
  return requestJson(
    `/api/v1/threads?${search.toString()}`,
    ThreadListResponseSchema,
    signal === undefined ? undefined : { signal },
  )
}

function appendRecipients(form: FormData, key: 'to' | 'cc' | 'bcc', value: string): void {
  const addresses = value.trim()
  if (addresses) form.set(key, addresses)
}

export function sendReply(threadId: string, draft: ReplyDraft) {
  const form = new FormData()
  appendRecipients(form, 'to', draft.to)
  appendRecipients(form, 'cc', draft.cc)
  appendRecipients(form, 'bcc', draft.bcc)
  form.set('subject', draft.subject)
  form.set('body', draft.body)
  form.set('format', 'markdown')
  if (draft.targetMessageId !== null) form.set('targetMessageId', draft.targetMessageId)
  for (const file of draft.attachments) form.append('attachments', file)

  return requestJson(
    `/api/v1/threads/${encodeURIComponent(threadId)}/messages`,
    SendResponseSchema,
    {
      method: 'POST',
      headers: { 'idempotency-key': draft.idempotencyKey },
      body: form,
    },
  )
}

export function sendNewMessage(mailboxId: string, draft: NewMessageDraft) {
  const form = new FormData()
  form.set('mailboxId', mailboxId)
  appendRecipients(form, 'to', draft.to)
  appendRecipients(form, 'cc', draft.cc)
  appendRecipients(form, 'bcc', draft.bcc)
  form.set('subject', draft.subject)
  form.set('body', draft.body)
  form.set('format', 'markdown')
  for (const file of draft.attachments) form.append('attachments', file)

  return requestJson('/api/v1/messages', SendResponseSchema, {
    method: 'POST',
    headers: { 'idempotency-key': draft.idempotencyKey },
    body: form,
  })
}
