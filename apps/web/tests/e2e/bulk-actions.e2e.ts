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

test('bulk moves checked conversations to Trash or Spam and undoes each move', async ({
  page,
  bulkHarness,
}) => {
  const subjects = ['Bulk 1', 'Bulk 2', 'Bulk 3', 'Bulk 4']
  for (const [index, subject] of subjects.entries()) {
    await injectSyntheticInbound(
      bulkHarness,
      [
        'From: promo@example.test',
        'To: inbox@example.test',
        `Subject: ${subject}`,
        `Message-ID: <bulk-${index}@example.test>`,
        `Date: Sat, 01 Aug 2026 12:0${index}:00 +0000`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `${subject} body.`,
      ].join('\r\n'),
    )
  }

  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  const list = page.getByTestId('thread-list')
  const row = (subject: string) => list.getByRole('button', { name: new RegExp(subject, 'u') })
  for (const subject of subjects) await expect(row(subject)).toBeVisible()
  const toolbar = page.getByRole('toolbar', { name: 'Bulk actions' })
  await expect(toolbar).toHaveCount(0)

  for (const subject of ['Bulk 1', 'Bulk 2', 'Bulk 3'])
    await page.getByRole('checkbox', { name: `Select conversation: ${subject}` }).click()
  await expect(toolbar).toContainText('3 selected')
  await toolbar.getByRole('button', { name: 'Trash' }).click()

  const status = page.getByRole('status').filter({ hasText: 'moved to' })
  await expect(status).toContainText('3 conversations moved to Trash.')
  await expect(row('Bulk 1')).toHaveCount(0)
  await expect(row('Bulk 4')).toBeVisible()
  await expect(toolbar).toHaveCount(0)
  expect(await folderSubjects(page, 'trash')).toEqual(['Bulk 1', 'Bulk 2', 'Bulk 3'])

  await status.getByRole('button', { name: 'Undo' }).click()
  await expect(status).toHaveCount(0)
  for (const subject of subjects) await expect(row(subject)).toBeVisible()
  expect(await folderSubjects(page, 'trash')).toEqual([])

  const selectAll = page.getByRole('checkbox', { name: 'Select all conversations in view' })
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
