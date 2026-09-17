import { mkdir } from 'node:fs/promises'
import { expect, test as base } from '@playwright/test'
import {
  migrateAndSeedHarness,
  startInboxTestHarness,
  TEST_MAGIC_TOKEN,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

const test = base.extend<{ organizationHarness: InboxTestHarness }>({
  organizationHarness: async ({ browserName }, use) => {
    void browserName
    const harness = await startInboxTestHarness()
    try {
      await migrateAndSeedHarness(harness)
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ organizationHarness }, use) => use(organizationHarness.origin),
})

function mail(to: string, id: string, subject: string, extra: string[] = []) {
  return [
    'From: sender@example.test',
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@example.test>`,
    ...extra,
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Message body for ${id}.`,
  ].join('\r\n')
}

test('promotes catch-all aliases, preserves Sent conversations, and manages blacklist spam', async ({
  page,
  organizationHarness: harness,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const alias = 'discovered@example.test'
  await harness.worker.email({
    from: 'sender@example.test',
    to: alias,
    raw: mail(alias, 'first', 'Alias conversation'),
  })
  await page.goto(`/auth/verify?token=${TEST_MAGIC_TOKEN}`)
  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const mailbox = page
    .getByRole('combobox', { name: 'Mailbox', exact: true })
    .filter({ visible: true })
  await expect(mailbox.locator('option', { hasText: alias })).toHaveCount(0)
  await mailbox.selectOption('other')
  await expect(page).toHaveURL((url) => url.searchParams.get('mailbox') === 'other')
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /Alias conversation/ })
    .click()
  await expect(page.getByTestId('conversation-pane')).toContainText(`Received at ${alias}`)
  await page.getByRole('button', { name: 'Create inbox for this alias' }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('mailbox')).not.toBe('other')
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /Alias conversation/ })
    .click()
  const conversation = page.getByTestId('conversation-pane')
  await conversation.getByRole('button', { name: 'Star message', exact: true }).click()
  await expect(
    conversation.getByRole('button', { name: 'Unstar message', exact: true }),
  ).toBeVisible()
  await conversation.getByRole('button', { name: 'Reply', exact: true }).click()
  const reply = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Reply', exact: true }) })
  await reply.getByLabel('Message', { exact: true }).fill('A synthetic reply from this alias.')
  await reply.getByRole('button', { name: 'Send reply' }).click()
  await expect(reply).toContainText('Reply sent.')
  await reply.getByRole('button', { name: 'Cancel', exact: true }).click()
  const threadId = new URL(page.url()).searchParams.get('thread')!
  const detail = await (await page.request.get(`/api/v1/threads/${threadId}`)).json()
  const outbound = detail.messages.find(
    (message: { direction: string }) => message.direction === 'outbound',
  )
  expect(outbound).toBeTruthy()
  await harness.worker.email({
    from: 'sender@example.test',
    to: alias,
    raw: mail(alias, 'followup', 'Re: Alias conversation', [
      `In-Reply-To: ${outbound.internetMessageId}`,
      `References: <first@example.test> ${outbound.internetMessageId}`,
    ]),
  })
  if (mobile) await page.getByRole('button', { name: 'Back to conversations' }).click()
  await page
    .getByRole('navigation', { name: 'Mailbox folders' })
    .filter({ visible: true })
    .getByRole('button', { name: /^Sent\b/ })
    .click()
  await expect(page).toHaveURL((url) => url.searchParams.get('folder') === 'sent')
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /Alias conversation/ })
    .click()
  await expect(page).toHaveURL((url) => url.searchParams.get('folder') === 'sent')
  await expect(conversation.locator('article')).toHaveCount(3)
  await expect(conversation.locator('button[aria-expanded="false"]')).toHaveCount(2)
  await expect(conversation.getByText('Message body for followup.', { exact: true })).toBeVisible()
  await mkdir('/tmp/simple-inbox-qa', { recursive: true })
  await page.screenshot({ path: `/tmp/simple-inbox-qa/thread-${info.project.name}.png` })
  await conversation.locator('button[aria-expanded="false"]').first().click()
  await expect(conversation.getByText('Message body for first.', { exact: true })).toBeVisible()
  await conversation.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(conversation.getByRole('button', { name: 'Restore from trash' })).toBeVisible()
  await conversation.getByRole('button', { name: 'Restore from trash' }).click()
  await expect(conversation.getByRole('button', { name: 'Trash', exact: true })).toBeVisible()
  if (mobile) await page.getByRole('button', { name: 'Back to conversations' }).click()
  await page.getByRole('button', { name: /^(Mailbox settings|Settings)$/ }).click()
  const settings = page.getByRole('dialog', { name: 'Mailbox settings' })
  await settings.getByLabel('Blacklist type').selectOption('recipient')
  await settings.getByLabel('Blacklist value').fill('unused@example.test')
  await settings.getByRole('button', { name: 'Add to blacklist' }).click()
  await expect(
    settings.getByRole('button', { name: 'Remove unused@example.test from blacklist' }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await harness.worker.email({
    from: 'sender@example.test',
    to: 'unused@example.test',
    raw: mail('unused@example.test', 'blocked', 'Blacklisted alias mail'),
  })
  await mailbox.selectOption('other')
  await expect(page).toHaveURL((url) => url.searchParams.get('mailbox') === 'other')
  const folders = page
    .getByRole('navigation', { name: 'Mailbox folders' })
    .filter({ visible: true })
  await folders.getByRole('button', { name: /^Inbox\b/ }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get('folder') !== 'sent')
  await expect(
    page.getByTestId('thread-list').getByRole('button', { name: /Blacklisted alias mail/ }),
  ).toHaveCount(0)
  await folders.getByRole('button', { name: /^Spam\b/ }).click()
  await expect(page).toHaveURL((url) => url.searchParams.get('folder') === 'spam')
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /Blacklisted alias mail/ })
    .click()
  await expect(conversation).toContainText('Blocked inbound alias')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
  await mkdir('/tmp/simple-inbox-qa', { recursive: true })
  await page.screenshot({
    path: `/tmp/simple-inbox-qa/spam-${info.project.name}.png`,
    fullPage: false,
  })
  await conversation.getByRole('button', { name: 'Not spam', exact: true }).click()
  await expect(conversation.getByText('Spam · Blocked inbound alias', { exact: true })).toHaveCount(
    0,
  )
  if (mobile) await page.getByRole('button', { name: 'Back to conversations' }).click()
  await mailbox.selectOption('create')
  const create = page.getByRole('dialog', { name: 'New inbox', exact: true })
  await create.getByLabel('Email address').fill('quick@example.test')
  await create.getByRole('checkbox', { name: 'Forward future mail to me' }).uncheck()
  await create.getByRole('button', { name: 'Create inbox', exact: true }).click()
  await expect(create).not.toBeVisible()
  await expect(mailbox.locator('option:checked')).toHaveText('quick@example.test')
  expect(errors).toEqual([])
})
