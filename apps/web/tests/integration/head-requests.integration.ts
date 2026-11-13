import {
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  migrateAndSeedHarness,
  sessionCookie,
  startInboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { InboxTestHarness } from '@cloudflare-inbox/test-harness'

describe('HEAD requests to server-rendered routes', () => {
  let harness: InboxTestHarness
  let cookie: string

  beforeAll(async () => {
    harness = await startInboxTestHarness()
    await migrateAndSeedHarness(harness)
    const verify = await harness.server.fetch('/api/v1/auth/magic-links/verify', {
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(verify.status).toBe(200)
    cookie = sessionCookie(verify)
  })

  afterAll(async () => {
    await harness.close()
  })

  async function statuses(path: string, headers: Record<string, string> = {}) {
    const get = await harness.server.fetch(path, { headers, redirect: 'manual' })
    await get.body?.cancel()
    const head = await harness.server.fetch(path, { headers, method: 'HEAD', redirect: 'manual' })
    return {
      get: { location: get.headers.get('location'), status: get.status },
      head: { location: head.headers.get('location'), status: head.status },
      headBody: await head.text(),
    }
  }

  it.each(['/', '/sign-in', '/setup', '/docs'])('%s answers HEAD like GET', async (path) => {
    const result = await statuses(path)
    expect(result.head).toEqual(result.get)
    expect(result.head.status).toBeLessThan(500)
    expect(result.headBody).toBe('')
  })

  it.each(['/', '/sign-in', '/inbox?folder=all'])(
    '%s answers HEAD like GET when signed in',
    async (path) => {
      const result = await statuses(path, { cookie })
      expect(result.head).toEqual(result.get)
      expect(result.head.status).toBeLessThan(500)
    },
  )

  it('renders the signed-in inbox for HEAD with the same status as GET', async () => {
    const result = await statuses(`/inbox?folder=all&mailbox=${TEST_IDS.mailbox}`, { cookie })
    expect(result.get.status).toBe(200)
    expect(result.head).toEqual(result.get)
    expect(result.headBody).toBe('')
  })
})
