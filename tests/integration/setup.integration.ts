import {
  TEST_ADDRESSES,
  TEST_SETUP_TOKEN,
  startInboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { InboxTestHarness } from '@cloudflare-inbox/test-harness'

describe('first-run setup in the single Worker', () => {
  let harness: InboxTestHarness

  beforeAll(async () => {
    harness = await startInboxTestHarness()
    await harness.worker.applyD1Migrations('DB')
  })

  afterAll(async () => {
    await harness.close()
  })

  it('fails closed until the owner completes setup once', async () => {
    const before = await harness.server.fetch('/api/v1/setup')
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({ status: 'required' })

    const protectedBefore = await harness.server.fetch('/api/v1/auth/session')
    expect(protectedBefore.status).toBe(503)

    const complete = await harness.server.fetch('/api/v1/setup', {
      body: JSON.stringify({
        applicationRecordRetentionDays: 90,
        mailDomain: 'example.test',
        mailboxAddress: TEST_ADDRESSES.mailbox,
        ownerEmail: TEST_ADDRESSES.owner,
        rawEmailRetentionDays: 30,
        retentionBatchSize: 100,
        setupToken: TEST_SETUP_TOKEN,
      }),
      headers: {
        'content-type': 'application/json',
        origin: harness.origin,
        'sec-fetch-site': 'same-origin',
      },
      method: 'POST',
    })
    expect(complete.status, await complete.clone().text()).toBe(201)
    expect(await complete.json()).toEqual({ status: 'complete' })

    const after = await harness.server.fetch('/api/v1/setup')
    expect(after.status).toBe(200)
    expect(await after.json()).toEqual({ status: 'complete' })

    const session = await harness.server.fetch('/api/v1/auth/session')
    expect(session.status).toBe(200)
    expect(await session.json()).toEqual({ authenticated: false })
  })
})
