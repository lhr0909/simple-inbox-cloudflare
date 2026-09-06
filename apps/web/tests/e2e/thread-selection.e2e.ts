import {
  injectSyntheticInbound,
  migrateAndSeedHarness,
  startInboxTestHarness,
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

import { expect, test as base } from '@playwright/test'

// This scenario needs its own one-use sign-in token, independent of the parity flow.
const test = base.extend<{ selectionHarness: InboxTestHarness }>({
  selectionHarness: async ({ browserName }, use) => {
    void browserName
    const harness = await startInboxTestHarness()
    try {
      await migrateAndSeedHarness(harness)
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ selectionHarness }, use) => use(selectionHarness.origin),
})

test('selects immediately, ignores late details, and preserves navigation under slow requests', async ({
  page,
  selectionHarness: inboxHarness,
}) => {
  for (const name of ['A', 'B']) {
    await injectSyntheticInbound(
      inboxHarness,
      [
        'From: sender@example.test',
        'To: inbox@example.test',
        `Subject: Selection ${name}`,
        `Message-ID: <selection-${name}@example.test>`,
        'Date: Sat, 01 Aug 2026 12:00:00 +0000',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Conversation ${name} body.`,
      ].join('\r\n'),
    )
  }

  // Simulate a transport that cannot cancel, so a late A response tests the commit guard too.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href)
      if (/^\/api\/v1\/threads\/[^/]+$/u.test(url.pathname) && init) {
        const { signal: _signal, ...uncancellable } = init
        return originalFetch(input, uncancellable)
      }
      return originalFetch(input, init)
    }
  })
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const list = page.getByTestId('thread-list')
  const rowA = list.getByRole('button', { name: /Selection A/u, includeHidden: true })
  const rowB = list.getByRole('button', { name: /Selection B/u, includeHidden: true })
  await expect(rowA).toBeVisible()
  await expect(rowB).toBeVisible()

  const result = await page.request.get(`/api/v1/threads?mailboxId=${TEST_IDS.mailbox}&folder=all`)
  const threads = (await result.json()) as { items: { id: string; subject: string }[] }
  const idA = threads.items.find((thread) => thread.subject === 'Selection A')!.id
  const idB = threads.items.find((thread) => thread.subject === 'Selection B')!.id
  let releaseA!: () => void
  const delayedA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  let aCompleted!: () => void
  const completedA = new Promise<void>((resolve) => {
    aCompleted = resolve
  })
  let aStarted!: () => void
  const startedA = new Promise<void>((resolve) => {
    aStarted = resolve
  })
  await page.route(`**/api/v1/threads/${idA}`, async (route) => {
    const response = await route.fetch()
    aStarted()
    await delayedA
    await route.fulfill({ response })
    aCompleted()
  })

  const listRequests: string[] = []
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (
      path.includes('/_serverFn/') ||
      path === '/api/v1/threads' ||
      path === '/api/v1/mailboxes'
    ) {
      listRequests.push(path)
    }
  })

  await rowA.click()
  await startedA
  await expect(rowA).toHaveAttribute('aria-pressed', 'true')
  await expect(rowB).toBeEnabled()
  await expect(page.getByRole('status')).toContainText('Loading conversation')
  const mobile = (page.viewportSize()?.width ?? 0) < 768
  if (mobile) await page.getByRole('button', { name: 'Back to conversations' }).click()
  await rowB.click()
  await expect(rowB).toHaveAttribute('aria-pressed', 'true')
  await expect(
    page.getByTestId('conversation-pane').getByText('Conversation B body.', { exact: true }),
  ).toBeVisible()
  const finishedA = page.waitForEvent(
    'requestfinished',
    (request) => new URL(request.url()).pathname === `/api/v1/threads/${idA}`,
  )
  releaseA()
  await completedA
  await finishedA
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
  await expect(
    page.getByTestId('conversation-pane').getByText('Conversation A body.', { exact: true }),
  ).toHaveCount(0)
  await expect(rowB).toHaveAttribute('aria-pressed', 'true')
  expect(listRequests).toEqual([])

  await page.goBack()
  if (mobile) await expect(list).toBeVisible()
  else
    await expect(
      page.getByTestId('conversation-pane').getByText('Conversation A body.', { exact: true }),
    ).toBeVisible()
  await page.goForward()
  await expect(
    page.getByTestId('conversation-pane').getByText('Conversation B body.', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByTestId('conversation-pane').getByText('Conversation B body.', { exact: true }),
  ).toBeVisible()
  expect(new URL(page.url()).searchParams.get('thread')).toBe(idB)

  // A failed detail request leaves the list available and supports an explicit retry.
  await page.route(`**/api/v1/threads/${idB}`, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{}',
    }),
  )
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('could not be loaded')
  await expect(rowA).toBeEnabled()
  await page.unroute(`**/api/v1/threads/${idB}`)
  await page.getByRole('button', { name: 'Retry conversation' }).click()
  await expect(
    page.getByTestId('conversation-pane').getByText('Conversation B body.', { exact: true }),
  ).toBeVisible()

  await page.goto(
    `/inbox?folder=all&mailbox=${TEST_IDS.mailbox}&thread=019fbbcf-73c9-7a01-8a00-000000000099`,
  )
  await expect(page.getByRole('alert')).toContainText('no longer available')
  await expect(rowA).toBeEnabled()
  if (mobile) {
    await page.getByRole('button', { name: 'Back to conversations' }).click()
    await expect(list).toBeVisible()
  }
})
