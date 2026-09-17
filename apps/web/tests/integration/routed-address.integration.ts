import {
  TEST_MAGIC_TOKEN,
  migrateAndSeedHarness,
  sessionCookie,
  startInboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import { expect, it } from 'vitest'

it('loads the inbox after receiving mail for a slash-containing routed address', async () => {
  const harness = await startInboxTestHarness()
  try {
    await migrateAndSeedHarness(harness)
    const address = 'alerts/team@example.test'
    const sender = 'sender/tag@example.test'
    const received = await harness.worker.email({
      from: sender,
      to: address,
      raw: [
        `From: ${sender}`,
        `To: ${address}`,
        'Subject: Routed address regression',
        'Message-ID: <routed-address-regression@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Synthetic routed message.',
      ].join('\r\n'),
    })
    expect(received.outcome).toBe('ok')

    const verify = await harness.server.fetch('/api/v1/auth/magic-links/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
    })
    expect(verify.status).toBe(200)
    const headers = { cookie: sessionCookie(verify) }
    const mailboxes = await harness.server.fetch('/api/v1/mailboxes', { headers })
    expect(mailboxes.status).toBe(200)
    const body = (await mailboxes.json()) as { mailboxes: Array<{ address: string; id: string }> }
    const mailbox = body.mailboxes.find((item) => item.address === address)
    expect(mailbox).toBeDefined()
    if (!mailbox) throw new Error('Synthetic routed mailbox was not created.')

    const query = new URLSearchParams({ mailboxId: mailbox.id, folder: 'all' })
    const threads = await harness.server.fetch(`/api/v1/threads?${query}`, { headers })
    expect(threads.status).toBe(200)
    const page = (await threads.json()) as { items: Array<{ id: string }> }
    expect(page.items).toHaveLength(1)
    const detail = await harness.server.fetch(`/api/v1/threads/${page.items[0]?.id}`, { headers })
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      messages: [{ from: { address: sender }, recipients: [{ address }] }],
    })

    const inbox = await harness.server.fetch('/inbox?folder=all', { headers })
    expect(inbox.status).toBe(200)
    expect(await inbox.text()).toContain('Routed address regression')
  } finally {
    await harness.close()
  }
})
