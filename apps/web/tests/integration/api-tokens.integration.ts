import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  TEST_SECOND_API_TOKEN,
  migrateAndSeedHarness,
  sameOriginHeaders,
  sessionCookie,
  startInboxTestHarness,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import type {
  ApiTokenCreatedResponse,
  ThreadDetailResponse,
  ThreadListResponse,
} from '@cloudflare-inbox/contracts'

describe('owner-issued inbox-scoped API tokens', () => {
  let harness: InboxTestHarness
  let cookie: string
  let excludedMailbox: string
  let allowedThread: string
  let excludedThread: string
  let excludedMessage: string
  let excludedAttachment: string
  let hiddenMailbox: string
  beforeAll(async () => {
    harness = await startInboxTestHarness()
    await migrateAndSeedHarness(harness)
    cookie = sessionCookie(
      await request('/auth/magic-links/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
      }),
    )
    const second = await ownerPost('/mailboxes', {
      address: 'excluded@example.test',
      forwardTo: null,
    })
    expect(second.status).toBe(200)
    excludedMailbox = ((await second.json()) as { id: string }).id
    for (const address of ['inbox@example.test', 'excluded@example.test', 'hidden@example.test']) {
      await harness.worker.email({
        from: 'customer@example.test',
        to: address,
        raw: [
          'From: customer@example.test',
          `To: ${address}`,
          'Subject: Agent scope needle',
          `Message-ID: <${address}>`,
          'MIME-Version: 1.0',
          'Content-Type: multipart/mixed; boundary=scope',
          '',
          '--scope',
          'Content-Type: text/plain',
          '',
          'Agent scope needle',
          '--scope',
          'Content-Type: text/plain; name="note.txt"',
          'Content-Disposition: attachment; filename="note.txt"',
          '',
          'Private attachment',
          '--scope--',
          '',
        ].join('\r\n'),
      })
    }
    const mailboxes = (await (await request('/mailboxes', { headers: { cookie } })).json()) as {
      mailboxes: { id: string; address: string }[]
    }
    hiddenMailbox = mailboxes.mailboxes.find(
      (mailbox) => mailbox.address === 'hidden@example.test',
    )!.id
    async function thread(mailboxId: string) {
      return (
        (await (
          await request(`/threads?mailboxId=${mailboxId}`, { headers: { cookie } })
        ).json()) as ThreadListResponse
      ).items[0]!.id
    }
    allowedThread = await thread(TEST_IDS.mailbox)
    excludedThread = await thread(excludedMailbox)
    const detail = (await (
      await request(`/threads/${excludedThread}`, { headers: { cookie } })
    ).json()) as ThreadDetailResponse
    excludedMessage = detail.messages[0]!.id
    excludedAttachment = detail.messages[0]!.attachments[0]!.id
  })
  afterAll(async () => harness.close())
  function request(path: string, init?: RequestInit) {
    return fetch(new URL(`/api/v1${path}`, harness.origin), init)
  }
  function ownerPost(path: string, body: unknown) {
    return request(path, {
      method: 'POST',
      headers: { ...sameOriginHeaders(harness.origin, cookie), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  async function issue(overrides: Record<string, unknown> = {}) {
    const response = await ownerPost('/auth/api-tokens', {
      name: 'Synthetic agent',
      scopes: ['read', 'send', 'settings'],
      mailboxIds: [TEST_IDS.mailbox],
      ...overrides,
    })
    expect(response.status, await response.clone().text()).toBe(201)
    expect(response.headers.get('cache-control')).toContain('no-store')
    return (await response.json()) as ApiTokenCreatedResponse
  }
  function headers(token: string) {
    return { authorization: `Bearer ${token}` }
  }
  function post(token: string, path: string, body: unknown) {
    return request(path, {
      method: 'POST',
      headers: { ...headers(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }
  function send(token: string, mailboxId: string, attachmentId?: string, threadId?: string) {
    const form = new FormData()
    for (const [key, value] of Object.entries({
      to: 'customer@example.test',
      subject: 'Synthetic agent reply',
      body: '**Hello**',
      format: 'markdown',
    }))
      form.set(key, value)
    if (!threadId) form.set('mailboxId', mailboxId)
    if (attachmentId) form.append('linkedAttachmentIds', attachmentId)
    return request(threadId ? `/threads/${threadId}/messages` : '/messages', {
      method: 'POST',
      headers: { ...headers(token), 'idempotency-key': crypto.randomUUID() },
      body: form,
    })
  }

  it('requires an owner session, same origin, owned selections, and future expiry', async () => {
    const body = { name: 'Agent', scopes: ['read'], mailboxIds: [TEST_IDS.mailbox] }
    expect((await request('/auth/api-tokens')).status).toBe(401)
    expect(
      (await request('/auth/api-tokens', { headers: headers(TEST_SECOND_API_TOKEN) })).status,
    ).toBe(403)
    expect(
      (
        await request('/auth/api-tokens', {
          method: 'POST',
          headers: {
            cookie,
            origin: 'https://foreign.example.test',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403)
    expect(
      (await ownerPost('/auth/api-tokens', { ...body, mailboxIds: [TEST_IDS.secondMailbox] }))
        .status,
    ).toBe(404)
    expect((await ownerPost('/auth/api-tokens', { ...body, mailboxIds: [] })).status).toBe(400)
    expect(
      (
        await ownerPost('/auth/api-tokens', {
          ...body,
          mailboxIds: [TEST_IDS.mailbox, TEST_IDS.mailbox],
        })
      ).status,
    ).toBe(400)
    expect(
      (await ownerPost('/auth/api-tokens', { ...body, expiresAt: '2020-01-01T00:00:00.000Z' }))
        .status,
    ).toBe(400)
    const issued = await issue()
    expect((await post(issued.token, '/auth/api-tokens', body)).status).toBe(403)
    expect(
      (
        await request(`/auth/api-tokens/${issued.apiToken.id}`, {
          method: 'DELETE',
          headers: headers(issued.token),
        })
      ).status,
    ).toBe(403)
    const listing = await request('/auth/api-tokens', { headers: { cookie } })
    expect(await listing.text()).not.toContain(issued.token)
  })

  it('filters lists, search and Other inbound and rejects excluded resource IDs and mutations', async () => {
    const { token } = await issue()
    const list = (await (await request('/mailboxes', { headers: headers(token) })).json()) as {
      mailboxes: { id: string }[]
    }
    expect(list.mailboxes.map((mailbox) => mailbox.id)).toEqual([TEST_IDS.mailbox])
    expect((await request(`/threads/${allowedThread}`, { headers: headers(token) })).status).toBe(
      200,
    )
    for (const path of [
      `/threads?mailboxId=${excludedMailbox}`,
      `/threads?mailboxId=${excludedMailbox}&q=needle`,
      `/threads/${excludedThread}`,
      `/messages/${excludedMessage}/raw`,
      `/messages/${excludedMessage}/html?preview=1`,
      `/messages/${excludedMessage}/attachments/${excludedAttachment}`,
    ])
      expect((await request(path, { headers: headers(token) })).status, path).toBe(404)
    for (const q of ['', '&q=needle']) {
      const page = (await (
        await request(`/threads?mailboxId=other${q}`, { headers: headers(token) })
      ).json()) as ThreadListResponse
      expect(page.items).toEqual([])
    }
    const hidden = await issue({ mailboxIds: [hiddenMailbox] })
    expect(
      (
        (await (
          await request('/threads?mailboxId=other&q=needle', { headers: headers(hidden.token) })
        ).json()) as ThreadListResponse
      ).items,
    ).toHaveLength(1)
    for (const path of [`/threads/${excludedThread}/read`, `/threads/${excludedThread}/archive`])
      expect((await post(token, path, {})).status).toBe(404)
    expect(
      (
        await request(`/threads/${excludedThread}/state`, {
          method: 'PATCH',
          headers: { ...headers(token), 'content-type': 'application/json' },
          body: JSON.stringify({ starred: true }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request(`/mailboxes/${excludedMailbox}`, {
          method: 'PATCH',
          headers: { ...headers(token), 'content-type': 'application/json' },
          body: JSON.stringify({ forwardTo: 'agent@example.test' }),
        })
      ).status,
    ).toBe(404)
    expect((await post(token, `/threads/${allowedThread}/read`, {})).status).toBe(204)
    expect(
      (
        await request(`/threads/${allowedThread}/state`, {
          method: 'PATCH',
          headers: { ...headers(token), 'content-type': 'application/json' },
          body: JSON.stringify({ starred: true }),
        })
      ).status,
    ).toBe(204)
    expect((await send(token, excludedMailbox)).status).toBe(404)
    expect((await send(token, excludedMailbox, undefined, excludedThread)).status).toBe(404)
    expect((await request('/spam-rules', { headers: headers(token) })).status).toBe(403)
    expect(
      (await post(token, '/spam-rules', { kind: 'domain', value: 'example.test' })).status,
    ).toBe(403)
    expect((await post(token, '/mailboxes', { address: 'agent@example.test' })).status).toBe(403)
    expect((await send(token, TEST_IDS.mailbox, undefined, allowedThread)).status).toBe(201)
  })

  it('isolates token uploads and prevents linked attachment access across inboxes', async () => {
    const allowed = await issue()
    const excluded = await issue({ mailboxIds: [excludedMailbox] })
    const file = { filename: 'empty.txt', mediaType: 'text/plain', size: 0 }
    const upload = (await (await post(excluded.token, '/uploads', file)).json()) as { id: string }
    expect(
      (await post(allowed.token, `/uploads/${upload.id}/complete`, { parts: [] })).status,
    ).toBe(404)
    expect(
      (
        await request(`/uploads/${upload.id}/parts/1`, {
          method: 'PUT',
          headers: headers(allowed.token),
          body: 'test',
        })
      ).status,
    ).toBe(404)
    expect((await send(allowed.token, TEST_IDS.mailbox, upload.id)).status).toBe(404)
    const sent = await send(excluded.token, excludedMailbox, upload.id)
    expect(sent.status).toBe(201)
    const message = (await sent.json()) as { messageId: string }
    expect(
      (
        await request(`/messages/${message.messageId}/attachments/${upload.id}`, {
          headers: headers(allowed.token),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await request(`/messages/${message.messageId}/attachments/${upload.id}`, {
          headers: headers(excluded.token),
        })
      ).status,
    ).toBe(200)
    const ownUpload = (await (await post(allowed.token, '/uploads', file)).json()) as { id: string }
    expect(
      (await post(allowed.token, `/uploads/${ownUpload.id}/complete`, { parts: [] })).status,
    ).toBe(204)
    expect((await send(allowed.token, TEST_IDS.mailbox, ownUpload.id)).status).toBe(201)
  })

  it('enforces read-only permissions and revocation, and records use without exposing secrets', async () => {
    const issued = await issue({ scopes: ['read'] })
    expect((await send(issued.token, TEST_IDS.mailbox)).status).toBe(403)
    expect((await post(issued.token, `/threads/${allowedThread}/read`, {})).status).toBe(403)
    expect((await request('/mailboxes', { headers: headers(issued.token) })).status).toBe(200)
    const list = (await (await request('/auth/api-tokens', { headers: { cookie } })).json()) as {
      tokens: { id: string; lastUsedAt: string | null }[]
    }
    expect(list.tokens.find((token) => token.id === issued.apiToken.id)?.lastUsedAt).not.toBeNull()
    const revokePath = `/auth/api-tokens/${issued.apiToken.id}`
    expect(
      (
        await request(revokePath, {
          method: 'DELETE',
          headers: { cookie, origin: 'https://foreign.example.test' },
        })
      ).status,
    ).toBe(403)
    for (let i = 0; i < 2; i++)
      expect(
        (
          await request(revokePath, {
            method: 'DELETE',
            headers: sameOriginHeaders(harness.origin, cookie),
          })
        ).status,
      ).toBe(204)
    expect((await request('/mailboxes', { headers: headers(issued.token) })).status).toBe(401)
  })

  it('makes all-inbox access explicit and keeps selected tokens fixed when new inboxes arrive', async () => {
    const all = await issue({ mailboxIds: null })
    const selected = await issue()
    const added = await ownerPost('/mailboxes', { address: 'future@example.test', forwardTo: null })
    const id = ((await added.json()) as { id: string }).id
    const accessible = (await (
      await request('/mailboxes', { headers: headers(all.token) })
    ).json()) as { mailboxes: { id: string }[] }
    expect(accessible.mailboxes.map((m) => m.id)).toContain(id)
    expect(accessible.mailboxes.map((m) => m.id)).not.toContain(TEST_IDS.secondMailbox)
    expect(
      (await request(`/threads?mailboxId=${id}`, { headers: headers(selected.token) })).status,
    ).toBe(404)
    expect((await request('/spam-rules', { headers: headers(all.token) })).status).toBe(200)
  })
})
