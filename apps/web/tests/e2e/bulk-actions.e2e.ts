import {
  injectSyntheticInbound,
  migrateAndSeedHarness,
  startInboxTestHarness,
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

import { expect, test as base, type Page } from '@playwright/test'

const test = base.extend<{ bulkHarness: InboxTestHarness }>({
  bulkHarness: async ({ browserName }, use) => {
    void browserName
    const harness = await startInboxTestHarness()
    try {
      await migrateAndSeedHarness(harness)
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ bulkHarness }, use) => use(bulkHarness.origin),
})

async function folderSubjects(page: Page, folder: string): Promise<string[]> {
  const response = await page.request.get(
    `/api/v1/threads?mailboxId=${TEST_IDS.mailbox}&folder=${folder}`,
  )
  const body = (await response.json()) as { items: { subject: string }[] }
  return body.items.map((thread) => thread.subject).sort()
}

async function seed(harness: InboxTestHarness, subjects: readonly string[]): Promise<void> {
  for (const [index, subject] of subjects.entries()) {
    await injectSyntheticInbound(
      harness,
      [
        'From: promo@example.test',
        'To: inbox@example.test',
        `Subject: ${subject}`,
        `Message-ID: <bulk-${index}@example.test>`,
        `Date: Sat, 01 Aug 2026 12:${String(index).padStart(2, '0')}:00 +0000`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `${subject} body.`,
      ].join('\r\n'),
    )
  }
}

async function threadId(page: Page, subject: string): Promise<string> {
  const response = await page.request.get(
    `/api/v1/threads?mailboxId=${TEST_IDS.mailbox}&folder=all&q=${encodeURIComponent(subject)}`,
  )
  const body = (await response.json()) as { items: { id: string; subject: string }[] }
  return body.items.find((thread) => thread.subject === subject)!.id
}

async function failStatePatches(page: Page, threadIds: readonly string[]): Promise<void> {
  await page.route('**/api/v1/threads/*/state', (route) =>
    threadIds.some((id) => route.request().url().includes(id))
      ? route.fulfill({ status: 503, body: '' })
      : route.fallback(),
  )
}

function bulkUi(page: Page) {
  const list = page.getByTestId('thread-list')
  return {
    row: (subject: string) => list.getByRole('button', { name: new RegExp(subject, 'u') }),
    selectAll: page.getByRole('checkbox', { name: 'Select all conversations in view' }),
    status: page.getByRole('status').filter({ has: page.getByRole('button', { name: 'Undo' }) }),
    toolbar: page.getByRole('toolbar', { name: 'Bulk actions' }),
  }
}

test('bulk moves checked conversations to Trash or Spam and undoes each move', async ({
  page,
  bulkHarness,
}) => {
  const subjects = ['Bulk 1', 'Bulk 2', 'Bulk 3', 'Bulk 4']
  await seed(bulkHarness, subjects)

  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const { row, selectAll, status, toolbar } = bulkUi(page)
  for (const subject of subjects) await expect(row(subject)).toBeVisible()
  await expect(toolbar).toHaveCount(0)

  for (const subject of ['Bulk 1', 'Bulk 2', 'Bulk 3'])
    await page.getByRole('checkbox', { name: `Select conversation: ${subject}` }).click()
  await expect(toolbar).toContainText('3 selected')
  await toolbar.getByRole('button', { name: 'Trash' }).click()

  await expect(status).toContainText('3 conversations moved to Trash.')
  await expect(row('Bulk 1')).toHaveCount(0)
  await expect(row('Bulk 4')).toBeVisible()
  await expect(toolbar).toHaveCount(0)
  expect(await folderSubjects(page, 'trash')).toEqual(['Bulk 1', 'Bulk 2', 'Bulk 3'])

  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(status).toHaveCount(0)
  for (const subject of subjects) await expect(row(subject)).toBeVisible()
  expect(await folderSubjects(page, 'trash')).toEqual([])

  await selectAll.click()
  await expect(toolbar).toContainText('4 selected')
  await toolbar.getByRole('button', { name: 'Spam' }).click()
  await expect(status).toContainText('4 conversations moved to Spam.')
  for (const subject of subjects) await expect(row(subject)).toHaveCount(0)
  expect(await folderSubjects(page, 'spam')).toEqual(subjects)

  await status.getByRole('button', { name: 'Undo' }).click()
  for (const subject of subjects) await expect(row(subject)).toBeVisible()
  expect(await folderSubjects(page, 'spam')).toEqual([])
  expect(await folderSubjects(page, 'inbox')).toEqual(expect.arrayContaining(subjects))
})

test('bulk Not spam in Spam and bulk Restore in Trash, each with Undo', async ({
  page,
  bulkHarness,
}) => {
  await seed(bulkHarness, ['Junk 1', 'Junk 2', 'Binned 1', 'Binned 2'])
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const { row, selectAll, status, toolbar } = bulkUi(page)
  for (const [subjects, action] of [
    [['Junk 1', 'Junk 2'], 'Spam'],
    [['Binned 1', 'Binned 2'], 'Trash'],
  ] as const) {
    for (const subject of subjects)
      await page.getByRole('checkbox', { name: `Select conversation: ${subject}` }).click()
    await toolbar.getByRole('button', { name: action, exact: true }).click()
    await expect(row(subjects[0])).toHaveCount(0)
  }
  expect(await folderSubjects(page, 'spam')).toEqual(['Junk 1', 'Junk 2'])
  expect(await folderSubjects(page, 'trash')).toEqual(['Binned 1', 'Binned 2'])

  await page.goto(`/inbox?mailbox=${TEST_IDS.mailbox}&folder=spam`)
  await expect(row('Junk 2')).toBeVisible()
  await selectAll.click()
  await expect(toolbar).toContainText('2 selected')
  await expect(toolbar.getByRole('button', { name: 'Trash' })).toBeVisible()
  await expect(toolbar.getByRole('button', { name: 'Spam', exact: true })).toHaveCount(0)
  await toolbar.getByRole('button', { name: 'Not spam' }).click()
  await expect(status).toContainText('2 conversations marked as not spam.')
  await expect(row('Junk 1')).toHaveCount(0)
  expect(await folderSubjects(page, 'spam')).toEqual([])
  expect(await folderSubjects(page, 'inbox')).toEqual(expect.arrayContaining(['Junk 1', 'Junk 2']))

  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(status).toHaveCount(0)
  await expect(row('Junk 1')).toBeVisible()
  expect(await folderSubjects(page, 'spam')).toEqual(['Junk 1', 'Junk 2'])

  await page.goto(`/inbox?mailbox=${TEST_IDS.mailbox}&folder=trash`)
  await expect(row('Binned 2')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select conversation: Binned 1' }).click()
  await expect(toolbar.getByRole('button')).toHaveText(['Restore', ''])
  await toolbar.getByRole('button', { name: 'Restore' }).click()
  await expect(status).toContainText('1 conversation restored from Trash.')
  await expect(row('Binned 1')).toHaveCount(0)
  await expect(row('Binned 2')).toBeVisible()
  expect(await folderSubjects(page, 'trash')).toEqual(['Binned 2'])
  expect(await folderSubjects(page, 'inbox')).toEqual(expect.arrayContaining(['Binned 1']))

  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(status).toHaveCount(0)
  await expect(row('Binned 1')).toBeVisible()
  expect(await folderSubjects(page, 'trash')).toEqual(['Binned 1', 'Binned 2'])
})

test('keeps failed rows from later pages selected and retries a failed Undo', async ({
  page,
  bulkHarness,
}) => {
  const subjects = Array.from(
    { length: 55 },
    (_, index) => `Page ${String(index).padStart(3, '0')}`,
  )
  await seed(bulkHarness, subjects)
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const { row, status, toolbar } = bulkUi(page)
  const firstPage = await page.request.get(
    `/api/v1/threads?mailboxId=${TEST_IDS.mailbox}&folder=inbox&limit=50`,
  )
  const firstSubjects = new Set(
    ((await firstPage.json()) as { items: { subject: string }[] }).items.map((t) => t.subject),
  )
  const [failing, moving] = subjects.filter((subject) => !firstSubjects.has(subject))
  await page.getByRole('button', { name: 'Load more conversations' }).click()
  await expect(row(failing!)).toBeVisible()
  const rows = page.getByTestId('thread-list').getByRole('checkbox')
  await expect(rows).toHaveCount(55)

  const failingId = await threadId(page, failing!)
  const movingId = await threadId(page, moving!)
  await failStatePatches(page, [failingId])
  await page.getByRole('checkbox', { name: `Select conversation: ${failing}` }).click()
  await page.getByRole('checkbox', { name: `Select conversation: ${moving}` }).click()
  await toolbar.getByRole('button', { name: 'Trash' }).click()

  await expect(status).toContainText('1 conversation moved to Trash.')
  await expect(page.getByRole('alert')).toContainText(
    '1 of 2 conversations could not be updated. They are still selected.',
  )
  await expect(row(moving!)).toHaveCount(0)
  await expect(rows).toHaveCount(54)
  await expect(
    page.getByRole('checkbox', { name: `Select conversation: ${failing}` }),
  ).toBeChecked()
  await expect(toolbar).toContainText('1 selected')
  expect(await folderSubjects(page, 'trash')).toEqual([moving])

  await page.unrouteAll()
  await failStatePatches(page, [movingId])
  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByRole('alert')).toContainText(
    '1 of 1 conversations could not be moved back. Select Undo to try again.',
  )
  await expect(status).toContainText('1 conversation moved to Trash.')
  expect(await folderSubjects(page, 'trash')).toEqual([moving])

  await page.unrouteAll()
  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(status).toHaveCount(0)
  await expect(row(moving!)).toBeVisible()
  await expect(rows).toHaveCount(55)
  expect(await folderSubjects(page, 'trash')).toEqual([])
})

test('Shift-click selects a range and Escape clears the selection outside text fields', async ({
  page,
  bulkHarness,
}) => {
  await seed(bulkHarness, ['Range A', 'Range B', 'Range C', 'Range D', 'Range E'])
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const { row, toolbar } = bulkUi(page)
  await expect(row('Range A')).toBeVisible()
  const box = (subject: string) =>
    page.getByRole('checkbox', { name: `Select conversation: ${subject}` })

  await box('Range E').click()
  await box('Range B').click({ modifiers: ['Shift'] })
  await expect(toolbar).toContainText('4 selected')
  for (const subject of ['Range E', 'Range D', 'Range C', 'Range B'])
    await expect(box(subject)).toBeChecked()
  await expect(box('Range A')).not.toBeChecked()

  await box('Range C').click({ modifiers: ['Shift'] })
  await expect(toolbar).toContainText('2 selected')
  await expect(box('Range C')).not.toBeChecked()
  await expect(box('Range B')).not.toBeChecked()

  await page.getByRole('searchbox', { name: 'Search conversations' }).press('Escape')
  await expect(toolbar).toContainText('2 selected')

  await box('Range A').focus()
  await page.keyboard.press('Escape')
  await expect(toolbar).toHaveCount(0)
  for (const subject of ['Range E', 'Range D']) await expect(box(subject)).not.toBeChecked()
})

test('the Undo offer expires after eight seconds', async ({ page, bulkHarness }) => {
  await seed(bulkHarness, ['Expiry 1', 'Expiry 2'])
  await page.clock.install()
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const { row, status, toolbar } = bulkUi(page)
  await expect(row('Expiry 1')).toBeVisible()
  await page.getByRole('checkbox', { name: 'Select conversation: Expiry 1' }).click()
  await toolbar.getByRole('button', { name: 'Trash' }).click()
  await expect(status).toContainText('1 conversation moved to Trash.')

  await page.clock.runFor(7_000)
  await expect(status).toBeVisible()
  await page.clock.runFor(1_500)
  await expect(status).toHaveCount(0)
  expect(await folderSubjects(page, 'trash')).toEqual(['Expiry 1'])
})
