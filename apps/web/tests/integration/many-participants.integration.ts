import {
  TEST_ADDRESSES,
  TEST_MAGIC_TOKEN,
  migrateAndSeedHarness,
  sameOriginHeaders,
  sessionCookie,
  startInboxTestHarness,
} from '@cloudflare-inbox/test-harness'
import { expect, it } from 'vitest'

it('opens a mailbox whose thread has more than 100 distinct participants', async () => {
  const harness = await startInboxTestHarness()
  try {
    await migrateAndSeedHarness(harness)
    const verify = await harness.server.fetch('/api/v1/auth/magic-links/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_MAGIC_TOKEN }),
    })
    expect(verify.status).toBe(200)
    const cookie = sessionCookie(verify)
    const authHeaders = sameOriginHeaders(harness.origin, cookie)

    const mailboxAddress = 'group@example.test'
    const created = await harness.server.fetch('/api/v1/mailboxes', {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ address: mailboxAddress, forwardTo: TEST_ADDRESSES.owner }),
    })
    expect(created.status).toBe(200)
    const mailbox = (await created.json()) as { id: string }

    const toAddresses = [
      mailboxAddress,
      ...Array.from(
        { length: 99 },
        (_, index) => `recipient-${String(index + 1).padStart(2, '0')}@example.test`,
      ),
    ]
    const sender = 'sender@example.test'
    const received = await harness.worker.email({
      from: sender,
      to: mailboxAddress,
      raw: [
        `From: Synthetic Sender <${sender}>`,
        `Reply-To: Synthetic Sender <${sender}>`,
        `To: ${toAddresses.join(', ')}`,
        'Subject: Synthetic mass-recipient notice',
        'Message-ID: <synthetic-mass-recipient@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Synthetic message with 101 distinct participants.',
      ].join('\r\n'),
    })
    expect(received.outcome).toBe('ok')

    const headers = { cookie }
    const query = new URLSearchParams({
      mailboxId: mailbox.id,
      folder: 'inbox',
      limit: '50',
    })
    const threads = await harness.server.fetch(`/api/v1/threads?${query}`, { headers })
    expect(threads.status).toBe(200)
    const page = (await threads.json()) as {
      items: Array<{
        id: string
        participants: Array<{ address: string; displayName: string | null }>
      }>
    }
    expect(page.items).toHaveLength(1)
    const summary = page.items[0]
    expect(summary?.participants).toHaveLength(100)
    expect(summary?.participants[0]?.address).toBe(mailboxAddress)

    const detail = await harness.server.fetch(`/api/v1/threads/${summary?.id}`, { headers })
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as {
      thread: { participants: Array<{ address: string }> }
      messages: Array<{ recipients: Array<{ kind: string }> }>
    }
    expect(detailBody.thread.participants).toHaveLength(100)
    expect(detailBody.messages[0]?.recipients).toHaveLength(101)

    const inbox = await harness.server.fetch(`/inbox?folder=inbox&mailbox=${mailbox.id}`, {
      headers,
    })
    expect(inbox.status).toBe(200)
    expect(await inbox.text()).toContain('Synthetic mass-recipient notice')
  } finally {
    await harness.close()
  }
})
