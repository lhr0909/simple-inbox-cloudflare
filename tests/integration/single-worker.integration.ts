import {
  TEST_ADDRESSES,
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  TEST_SECOND_API_TOKEN,
  injectSyntheticInbound,
  migrateAndSeedHarness,
  sameOriginHeaders,
  sessionCookie,
  startInboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { InboxTestHarness } from '@cloudflare-inbox/test-harness'

describe('production single-Worker topology', () => {
  let harness: InboxTestHarness

  beforeAll(async () => {
    harness = await startInboxTestHarness()
    await migrateAndSeedHarness(harness)
  })

  afterAll(async () => {
    await harness.close()
  })

  it.each([
    '/internal/health',
    '/internal/v1/send',
    '/internal/v1/auth/magic-link',
    '/internal/v1/sends/public-probe',
    '/api/v1/internal/health',
  ])('never exposes the private mail surface at %s', async (path) => {
    const response = await harness.server.fetch(path)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('"service":"mail"')
  })

  it('exercises web -> API -> mail with isolated D1/R2 and simulated email delivery', async () => {
    const requestId = 'integration_trace_0001'
    const magicRequest = await harness.server.fetch('/api/v1/auth/magic-links', {
      body: JSON.stringify({ email: TEST_ADDRESSES.owner }),
      headers: {
        'content-type': 'application/json',
        'x-request-id': requestId,
      },
      method: 'POST',
    })
    expect(magicRequest.status).toBe(202)
    expect(await magicRequest.json()).toEqual({ status: 'accepted' })
    expect(magicRequest.headers.get('x-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(magicRequest.headers.get('x-request-id')).not.toBe(requestId)

    const verify = await harness.server.fetch('/api/v1/auth/magic-links/verify', {
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(verify.status, await verify.clone().text()).toBe(200)
    const cookie = sessionCookie(verify)

    const empty = await privateFetch(harness, '/api/v1/threads', cookie, {
      mailboxId: TEST_IDS.mailbox,
      folder: 'all',
      limit: '25',
    })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ items: [], nextCursor: null })

    await injectSyntheticInbound(harness)

    const list = await privateFetch(harness, '/api/v1/threads', cookie, {
      mailboxId: TEST_IDS.mailbox,
      folder: 'all',
      limit: '25',
    })
    expect(list.status, await list.clone().text()).toBe(200)
    const listed = (await list.json()) as {
      items: Array<{ id: string; subject: string; unreadCount: number }>
    }
    expect(listed.items).toHaveLength(1)
    expect(listed.items[0]).toMatchObject({
      subject: 'Synthetic quarterly check-in',
      unreadCount: 1,
    })
    const threadId = listed.items[0]?.id
    expect(threadId).toMatch(/^[0-9a-f-]{36}$/u)
    if (!threadId) throw new Error('Inbound capture did not create a thread.')

    const detailResponse = await harness.server.fetch(`/api/v1/threads/${threadId}`, {
      headers: { cookie },
    })
    expect(detailResponse.status).toBe(200)
    const detail = (await detailResponse.json()) as {
      messages: Array<{
        attachments: Array<{ id: string; filename: string | null }>
        id: string
      }>
    }
    const inboundMessage = detail.messages[0]
    expect(inboundMessage?.attachments[0]?.filename).toBe('synthetic-report.txt')
    if (!inboundMessage) throw new Error('Inbound projection is missing.')

    const search = await privateFetch(harness, '/api/v1/threads', cookie, {
      mailboxId: TEST_IDS.mailbox,
      folder: 'all',
      limit: '25',
      q: 'quarterly',
    })
    expect(search.status).toBe(200)
    expect((await search.json()) as object).toMatchObject({ items: [{ id: threadId }] })

    const read = await mutate(harness, `/api/v1/threads/${threadId}/read`, cookie, 'POST')
    expect(read.status).toBe(204)
    const archive = await mutate(harness, `/api/v1/threads/${threadId}/archive`, cookie, 'POST')
    expect(archive.status).toBe(204)
    const unarchive = await mutate(harness, `/api/v1/threads/${threadId}/archive`, cookie, 'DELETE')
    expect(unarchive.status).toBe(204)

    const raw = await harness.server.fetch(`/api/v1/messages/${inboundMessage.id}/raw`, {
      headers: { cookie },
    })
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('message/rfc822')
    expect(await raw.text()).toContain('Message-ID: <synthetic-inbound-001@sender.test>')

    const attachmentId = inboundMessage.attachments[0]?.id
    if (!attachmentId) throw new Error('Inbound attachment projection is missing.')
    const attachment = await harness.server.fetch(
      `/api/v1/messages/${inboundMessage.id}/attachments/${attachmentId}`,
      { headers: { cookie } },
    )
    expect(attachment.status).toBe(200)
    expect(await attachment.text()).toBe('Synthetic report content.\n')

    const idempotencyKey = 'integration-reply-0000000001'
    const firstSend = await sendReply(harness, threadId, cookie, idempotencyKey)
    expect([201, 202], await firstSend.clone().text()).toContain(firstSend.status)
    const firstSendBody = (await firstSend.json()) as { id: string; threadId: string }
    expect(firstSendBody.threadId).toBe(threadId)
    const replay = await sendReply(harness, threadId, cookie, idempotencyKey)
    expect([201, 202], await replay.clone().text()).toContain(replay.status)
    expect(await replay.json()).toMatchObject({ id: firstSendBody.id, threadId })

    const composeKey = 'integration-compose-00000001'
    const firstCompose = await sendNewMessage(harness, cookie, composeKey)
    expect(firstCompose.status, await firstCompose.clone().text()).toBe(201)
    const composed = (await firstCompose.json()) as {
      id: string
      messageId: string | null
      state: string
      threadId: string
    }
    expect(composed).toMatchObject({ state: 'sent' })
    expect(composed.messageId).toMatch(/^[0-9a-f-]{36}$/u)
    const composeReplay = await sendNewMessage(harness, cookie, composeKey)
    expect(composeReplay.status).toBe(201)
    expect(await composeReplay.json()).toMatchObject({
      id: composed.id,
      messageId: composed.messageId,
      threadId: composed.threadId,
    })

    const composedSearch = await privateFetch(harness, '/api/v1/threads', cookie, {
      mailboxId: TEST_IDS.mailbox,
      folder: 'all',
      limit: '25',
      q: 'standalone compose',
    })
    expect(composedSearch.status).toBe(200)
    expect(await composedSearch.json()).toMatchObject({
      items: [
        {
          attachmentCount: 1,
          id: composed.threadId,
          lastMessageDirection: 'outbound',
          subject: 'Synthetic standalone compose',
          unreadCount: 0,
        },
      ],
    })
    const composedDetailResponse = await harness.server.fetch(
      `/api/v1/threads/${composed.threadId}`,
      { headers: { cookie } },
    )
    expect(composedDetailResponse.status).toBe(200)
    const composedDetail = (await composedDetailResponse.json()) as {
      messages: Array<{
        attachments: Array<{ filename: string | null; id: string }>
        direction: string
        id: string
        rawAvailable: boolean
        recipients: Array<{ address: string; kind: string }>
        sendState: string
        subject: string
        textBody: string
      }>
    }
    expect(composedDetail.messages).toHaveLength(1)
    const composedMessage = composedDetail.messages[0]
    expect(composedMessage).toMatchObject({
      direction: 'outbound',
      id: composed.messageId,
      rawAvailable: true,
      sendState: 'sent',
      subject: 'Synthetic standalone compose',
      textBody: 'A standalone deterministic message from the integration harness.',
    })
    expect(composedMessage?.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: 'recipient@example.net', kind: 'to' }),
        expect.objectContaining({ address: 'copy@example.net', kind: 'cc' }),
        expect.objectContaining({ address: 'audit@example.net', kind: 'bcc' }),
      ]),
    )
    expect(composedMessage?.attachments).toEqual([
      expect.objectContaining({ filename: 'compose-note.txt' }),
    ])
    if (!composedMessage) throw new Error('Composed message projection is missing.')

    const composedRaw = await harness.server.fetch(`/api/v1/messages/${composedMessage.id}/raw`, {
      headers: { cookie },
    })
    expect(composedRaw.status).toBe(200)
    expect(composedRaw.headers.get('content-type')).toBe('message/rfc822')
    const composedRawBody = await composedRaw.text()
    expect(composedRawBody).toContain('Subject: Synthetic standalone compose')
    expect(composedRawBody).toContain('Content-Transfer-Encoding: base64')
    expect(composedRawBody.replaceAll(/\s/gu, '')).toContain(
      Buffer.from(
        'A standalone deterministic message from the integration harness.',
        'utf8',
      ).toString('base64'),
    )
    const composedAttachmentId = composedMessage.attachments[0]?.id
    if (!composedAttachmentId) throw new Error('Composed attachment projection is missing.')
    const composedAttachment = await harness.server.fetch(
      `/api/v1/messages/${composedMessage.id}/attachments/${composedAttachmentId}`,
      { headers: { cookie } },
    )
    expect(composedAttachment.status).toBe(200)
    expect(await composedAttachment.text()).toBe('Synthetic compose attachment.\n')

    const updatedForwardTo = 'replacement-forward@example.net'
    const settingsUpdate = await harness.server.fetch(`/api/v1/mailboxes/${TEST_IDS.mailbox}`, {
      body: JSON.stringify({ forwardTo: updatedForwardTo }),
      headers: {
        ...sameOriginHeaders(harness.origin, cookie),
        'content-type': 'application/json',
      },
      method: 'PATCH',
    })
    expect(settingsUpdate.status, await settingsUpdate.clone().text()).toBe(200)
    expect(await settingsUpdate.json()).toMatchObject({
      forwardTo: updatedForwardTo,
      id: TEST_IDS.mailbox,
    })
    const ownerMailboxes = await harness.server.fetch('/api/v1/mailboxes', {
      headers: { cookie },
    })
    expect(ownerMailboxes.status).toBe(200)
    expect(await ownerMailboxes.json()).toEqual({
      mailboxes: [expect.objectContaining({ forwardTo: updatedForwardTo, id: TEST_IDS.mailbox })],
    })

    const forbiddenSettings = await harness.server.fetch(
      `/api/v1/mailboxes/${TEST_IDS.secondMailbox}`,
      {
        body: JSON.stringify({ forwardTo: 'cross-mailbox@example.net' }),
        headers: {
          ...sameOriginHeaders(harness.origin, cookie),
          'content-type': 'application/json',
        },
        method: 'PATCH',
      },
    )
    expect(forbiddenSettings.status).toBe(404)
    const secondMailboxes = await harness.server.fetch('/api/v1/mailboxes', {
      headers: { authorization: `Bearer ${TEST_SECOND_API_TOKEN}` },
    })
    expect(secondMailboxes.status).toBe(200)
    expect(await secondMailboxes.json()).toEqual({
      mailboxes: [
        expect.objectContaining({
          forwardTo: TEST_ADDRESSES.secondUser,
          id: TEST_IDS.secondMailbox,
        }),
      ],
    })

    const forbiddenThread = await harness.server.fetch(`/api/v1/threads/${threadId}`, {
      headers: { authorization: `Bearer ${TEST_SECOND_API_TOKEN}` },
    })
    expect(forbiddenThread.status).toBe(404)
    const forbiddenRaw = await harness.server.fetch(`/api/v1/messages/${inboundMessage.id}/raw`, {
      headers: { authorization: `Bearer ${TEST_SECOND_API_TOKEN}` },
    })
    expect(forbiddenRaw.status).toBe(404)
  })
})

async function privateFetch(
  harness: InboxTestHarness,
  path: string,
  cookie: string,
  query: Record<string, string>,
) {
  const search = new URLSearchParams(query)
  return harness.server.fetch(`${path}?${search.toString()}`, { headers: { cookie } })
}

function mutate(
  harness: InboxTestHarness,
  path: string,
  cookie: string,
  method: 'DELETE' | 'POST',
) {
  return harness.server.fetch(path, {
    headers: sameOriginHeaders(harness.origin, cookie),
    method,
  })
}

function sendReply(
  harness: InboxTestHarness,
  threadId: string,
  cookie: string,
  idempotencyKey: string,
) {
  const form = new FormData()
  form.append('to', TEST_ADDRESSES.inboundSender)
  form.append('cc', 'reviewer@example.test')
  form.append('bcc', 'audit@example.test')
  form.append('subject', 'Re: Synthetic quarterly check-in')
  form.append('body', 'A deterministic reply from the integration harness.')
  form.append('format', 'plain')
  form.append(
    'attachments',
    new File(['Synthetic reply attachment.\n'], 'reply-note.txt', { type: 'text/plain' }),
  )
  return sendMultipart(
    harness,
    `/api/v1/threads/${threadId}/messages`,
    form,
    cookie,
    idempotencyKey,
  )
}

function sendNewMessage(harness: InboxTestHarness, cookie: string, idempotencyKey: string) {
  const form = new FormData()
  form.append('mailboxId', TEST_IDS.mailbox)
  form.append('to', 'Recipient <recipient@example.net>')
  form.append('cc', 'copy@example.net')
  form.append('bcc', 'audit@example.net')
  form.append('subject', 'Synthetic standalone compose')
  form.append('body', 'A standalone deterministic message from the integration harness.')
  form.append('format', 'plain')
  form.append(
    'attachments',
    new File(['Synthetic compose attachment.\n'], 'compose-note.txt', { type: 'text/plain' }),
  )
  return sendMultipart(harness, '/api/v1/messages', form, cookie, idempotencyKey)
}

function sendMultipart(
  harness: InboxTestHarness,
  path: string,
  form: FormData,
  cookie: string,
  idempotencyKey: string,
) {
  const request = new Request(new URL(path, harness.origin), {
    body: form,
    headers: {
      ...sameOriginHeaders(harness.origin, cookie),
      'idempotency-key': idempotencyKey,
    },
    method: 'POST',
  })
  return fetch(request)
}
