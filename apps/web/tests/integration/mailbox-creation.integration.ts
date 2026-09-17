import {
  migrateAndSeedHarness,
  sameOriginHeaders,
  sessionCookie,
  startInboxTestHarness,
  TEST_MAGIC_TOKEN,
} from '@cloudflare-inbox/test-harness'
import { expect, it } from 'vitest'

it('creates mailboxes with explicit forwarding destinations while preserving v1 clients', async () => {
  const harness = await startInboxTestHarness()
  try {
    await migrateAndSeedHarness(harness)
    const verify = await harness.server.fetch('/api/v1/auth/magic-links/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
    })
    expect(verify.status).toBe(200)
    const headers = {
      ...sameOriginHeaders(harness.origin, sessionCookie(verify)),
      'content-type': 'application/json',
    }
    const cases = [
      { address: 'custom@example.test', forwardTo: 'Destination@Example.Test' },
      { address: 'off@example.test', forwardTo: null },
      { address: 'legacy@example.test' },
      { address: 'legacy-off@example.test', forward: false },
      { address: 'explicit@example.test', forward: false, forwardTo: 'destination@example.test' },
    ]
    const expected = [
      'destination@example.test',
      null,
      'owner@example.test',
      null,
      'destination@example.test',
    ]
    for (const [index, input] of cases.entries()) {
      const result = await harness.server.fetch('/api/v1/mailboxes', {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      })
      expect(result.status).toBe(200)
      expect(await result.json()).toMatchObject({
        address: input.address,
        forwardTo: expected[index],
        whitelisted: true,
        blocked: false,
      })
    }
    const invalid = await harness.server.fetch('/api/v1/mailboxes', {
      method: 'POST',
      headers,
      body: JSON.stringify({ address: 'invalid@example.test', forwardTo: 'not-an-email' }),
    })
    expect(invalid.status).toBe(400)
    const mailboxes = await harness.server.fetch('/api/v1/mailboxes', { headers })
    expect(await mailboxes.text()).not.toContain('invalid@example.test')
  } finally {
    await harness.close()
  }
})
