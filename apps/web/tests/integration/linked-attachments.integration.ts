import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  TEST_SECOND_API_TOKEN,
  migrateAndSeedHarness,
  readHarnessUpload,
  sameOriginHeaders,
  sessionCookie,
  startInboxTestHarness,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

describe('linked attachment delivery', () => {
  let harness: InboxTestHarness
  let cookie: string
  beforeAll(async () => {
    harness = await startInboxTestHarness()
    await migrateAndSeedHarness(harness)
    const response = await workerFetch('/api/v1/auth/magic-links/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
    })
    cookie = sessionCookie(response)
  })
  afterAll(async () => harness.close())

  function workerFetch(path: string, init?: Parameters<InboxTestHarness['worker']['fetch']>[1]) {
    return harness.worker.fetch(new URL(path, harness.origin).href, init)
  }

  function post(path: string, body: unknown) {
    return workerFetch(path, {
      method: 'POST',
      headers: { ...sameOriginHeaders(harness.origin, cookie), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('verifies multipart files, sends links, streams public downloads, and retains old mail', async () => {
    const firstPart = new Uint8Array(16 * 1024 * 1024).fill(65)
    const finalPart = new TextEncoder().encode('synthetic attachment end')
    const size = firstPart.length + finalPart.length
    const created = await post('/api/v1/uploads', {
      filename: 'customer-report.txt',
      mediaType: 'text/plain',
      size,
    })
    expect(created.status, await created.clone().text()).toBe(201)
    const upload = (await created.json()) as { id: string; partSize: number }
    expect(upload.partSize).toBe(firstPart.length)
    const { STORAGE } = await harness.worker.getEnv()
    const row = await readHarnessUpload(harness, upload.id)
    if (!row) throw new Error('Missing upload')
    const downloadPath = `/api/v1/downloads/${row.downloadToken}`
    {
      const response = await workerFetch(downloadPath)
      expect(response.status, await response.text()).toBe(404)
    }

    // An upload ID grants no rights to another owner; Origin remains mandatory.
    const otherOwner = await workerFetch(`/api/v1/uploads/${upload.id}/parts/1`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${TEST_SECOND_API_TOKEN}` },
      body: finalPart,
    })
    expect(otherOwner.status, await otherOwner.text()).toBe(404)
    const crossSite = await workerFetch('/api/v1/uploads', {
      method: 'POST',
      headers: { cookie, origin: 'https://other.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'x.txt', mediaType: 'text/plain', size: 1 }),
    })
    expect(crossSite.status, await crossSite.text()).toBe(403)

    for (const headers of [{}, { cookie, origin: 'https://other.example.test' }, { cookie }]) {
      const denied = await workerFetch(`/api/v1/uploads/${upload.id}/parts/1`, {
        method: 'PUT',
        headers,
        body: finalPart,
      })
      expect([401, 403], await denied.text()).toContain(denied.status)
    }
    for (const partNumber of ['0', '3', '10001', 'invalid']) {
      const invalid = await workerFetch(`/api/v1/uploads/${upload.id}/parts/${partNumber}`, {
        method: 'PUT',
        headers: sameOriginHeaders(harness.origin, cookie),
        body: finalPart,
      })
      expect(invalid.status, await invalid.text()).toBe(400)
    }

    // A retry can replace an unfinished part; completion must use the latest receipt.
    const retriedPart = await workerFetch(`/api/v1/uploads/${upload.id}/parts/2`, {
      method: 'PUT',
      headers: sameOriginHeaders(harness.origin, cookie),
      body: new Uint8Array(finalPart.length).fill(66),
    })
    expect(retriedPart.status, await retriedPart.text()).toBe(200)

    const parts: Array<{ partNumber: number; etag: string }> = []
    for (const [i, bytes] of [firstPart, finalPart].entries()) {
      const put = await workerFetch(`/api/v1/uploads/${upload.id}/parts/${i + 1}`, {
        method: 'PUT',
        headers: sameOriginHeaders(harness.origin, cookie),
        body: bytes,
      })
      expect(put.status, await put.clone().text()).toBe(200)
      parts.push({ partNumber: i + 1, etag: put.headers.get('etag')! })
    }
    expect(
      (await post(`/api/v1/uploads/${upload.id}/complete`, { parts: parts.toReversed() })).status,
    ).toBe(400)
    expect((await post(`/api/v1/uploads/${upload.id}/complete`, { parts })).status).toBe(204)
    expect((await post(`/api/v1/uploads/${upload.id}/complete`, { parts })).status).toBe(204)
    const overwrite = await workerFetch(`/api/v1/uploads/${upload.id}/parts/1`, {
      method: 'PUT',
      headers: sameOriginHeaders(harness.origin, cookie),
      body: finalPart,
    })
    expect(overwrite.status, await overwrite.text()).toBe(400)
    {
      const response = await workerFetch(downloadPath)
      expect(response.status, await response.text()).toBe(404)
    }

    async function send(key: string, uploadId = upload.id) {
      const body = new FormData()
      body.set('mailboxId', TEST_IDS.mailbox)
      body.set('to', 'customer@example.test')
      body.set('subject', 'Your support files')
      body.set('body', 'Here is your report.')
      body.set('format', 'markdown')
      body.append('linkedAttachmentIds', uploadId)
      return fetch(new URL('/api/v1/messages', harness.origin), {
        method: 'POST',
        headers: { ...sameOriginHeaders(harness.origin, cookie), 'idempotency-key': key },
        body,
      })
    }
    const sent = await send('linked-send-00000001')
    expect(sent.status, await sent.clone().text()).toBe(201)
    const result = (await sent.json()) as { id: string; messageId: string; threadId: string }
    const replay = await send('linked-send-00000001')
    expect(replay.status).toBe(201)
    expect(await replay.json()).toMatchObject({ id: result.id })
    const detail = await workerFetch(`/api/v1/threads/${result.threadId}`, {
      headers: { cookie },
    })
    expect(await detail.json()).toMatchObject({
      messages: [{ attachments: [{ id: upload.id, size, filename: 'customer-report.txt' }] }],
    })
    const raw = await workerFetch(`/api/v1/messages/${result.messageId}/raw`, {
      headers: { cookie },
    })
    const source = await raw.text()
    const alternatives = [
      ...source.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/gu),
    ].map((part) => Buffer.from(part[1]!, 'base64').toString('utf8'))
    expect(alternatives).toHaveLength(2)
    for (const alternative of alternatives) expect(alternative).toContain(row.downloadToken)
    expect(source).not.toContain('Content-Disposition: attachment')
    expect(source.length).toBeLessThan(10_000)

    const download = await workerFetch(downloadPath)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-disposition')).toContain('attachment;')
    expect(download.headers.get('content-disposition')).toContain('customer-report.txt')
    expect(download.headers.get('cache-control')).toContain('no-store')
    expect((await download.arrayBuffer()).byteLength).toBe(size)
    const range = await workerFetch(downloadPath, {
      headers: { range: `bytes=${firstPart.length}-` },
    })
    expect(range.status).toBe(206)
    expect(await range.text()).toBe('synthetic attachment end')
    const ownerDownload = await workerFetch(
      `/api/v1/messages/${result.messageId}/attachments/${upload.id}`,
      { headers: { cookie } },
    )
    expect(ownerDownload.status).toBe(200)
    await ownerDownload.body?.cancel()

    for (const location of ['spam', 'trash']) {
      const moved = await workerFetch(`/api/v1/threads/${result.threadId}/state`, {
        method: 'PATCH',
        headers: {
          ...sameOriginHeaders(harness.origin, cookie),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ location, messageIds: [result.messageId] }),
      })
      expect(moved.status).toBe(204)
    }

    // Even historical expiration settings and a scheduled event years later
    // must leave retained mail and linked files intact.
    await harness.worker.scheduled({
      scheduledTime: new Date(Date.now() + 20 * 365 * 86_400_000),
      cron: '17 3 * * *',
    })
    expect(await STORAGE.head(row.objectKey)).not.toBeNull()
    const stillShared = await workerFetch(downloadPath, { headers: { range: 'bytes=0-3' } })
    expect(stillShared.status).toBe(206)
    expect(await stillShared.text()).toBe('AAAA')
    const stillRaw = await workerFetch(`/api/v1/messages/${result.messageId}/raw`, {
      headers: { cookie },
    })
    expect(stillRaw.status).toBe(200)
    await stillRaw.body?.cancel()
  })

  it('accepts empty files and large file metadata without product quotas', async () => {
    for (const size of [0, 100 * 1024 ** 3]) {
      const response = await post('/api/v1/uploads', {
        filename: 'synthetic.bin',
        mediaType: 'application/octet-stream',
        size,
      })
      expect(response.status, await response.clone().text()).toBe(201)
      expect(await response.json()).toMatchObject({ complete: size === 0 })
    }
  })
})
