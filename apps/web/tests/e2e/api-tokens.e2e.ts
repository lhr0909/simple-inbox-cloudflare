import { mkdir } from 'node:fs/promises'
import { expect, test as base } from '@playwright/test'
import {
  TEST_MAGIC_TOKEN,
  TEST_IDS,
  injectSyntheticInbound,
  migrateAndSeedHarness,
  startInboxTestHarness,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

const test = base.extend<{ inboxHarness: InboxTestHarness }>({
  inboxHarness: async ({ browserName }, use) => {
    void browserName
    const harness = await startInboxTestHarness()
    try {
      await migrateAndSeedHarness(harness)
      await injectSyntheticInbound(harness)
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ inboxHarness }, use) => use(inboxHarness.origin),
})

test('creates, copies and revokes inbox-scoped tokens without redisplaying their secrets', async ({
  page,
  context,
  inboxHarness,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto(`/auth/verify?token=${TEST_MAGIC_TOKEN}`)
  await expect(page).toHaveURL((url) => url.pathname === '/inbox')
  await expect(page).toHaveTitle(/Inbox/)
  await expect(page.getByTestId('thread-list').locator('time').first()).not.toHaveText(
    /^\d{4}-\d{2}-\d{2}$/,
  )
  const added = await page.request.post('/api/v1/mailboxes', {
    headers: { origin: inboxHarness.origin },
    data: { address: 'second-support@example.test', forwardTo: null },
  })
  expect(added.status()).toBe(200)
  await page.getByRole('button', { name: 'General settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'General settings', exact: true })
  await dialog.getByRole('tab', { name: 'API tokens', exact: true }).click()
  const tokens = dialog.getByRole('region', { name: 'API tokens', exact: true })
  await expect(tokens.getByText('No API tokens yet.')).toBeVisible()
  await expect(tokens.getByRole('button', { name: 'Create token', exact: true })).toBeDisabled()
  await tokens.getByLabel('Token name', { exact: true }).fill('Support reader')
  await tokens.getByRole('checkbox', { name: 'inbox@example.test', exact: true }).check()
  await expect(
    tokens.getByRole('checkbox', { name: 'private@example.test', exact: true }),
  ).toHaveCount(0)
  await expect(tokens.getByRole('button', { name: 'Create token', exact: true })).toBeEnabled()
  await mkdir('/tmp/simple-inbox-api-tokens-qa', { recursive: true })
  await page.screenshot({ path: `/tmp/simple-inbox-api-tokens-qa/create-${info.project.name}.png` })
  await tokens.getByRole('button', { name: 'Create token', exact: true }).click()
  const secretInput = tokens.getByRole('textbox', { name: 'New API token', exact: true })
  await expect(secretInput).toBeVisible()
  const secret = await secretInput.inputValue()
  expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
  await tokens.getByRole('button', { name: 'Copy token', exact: true }).click()
  await expect(tokens.getByRole('button', { name: 'Copied', exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret)
  const accessible = await page.request.get('/api/v1/mailboxes', {
    headers: { authorization: `Bearer ${secret}` },
  })
  expect((await accessible.json()).mailboxes.map((mailbox: { id: string }) => mailbox.id)).toEqual([
    TEST_IDS.mailbox,
  ])
  await tokens.getByRole('button', { name: 'I saved the token', exact: true }).click()
  await expect(secretInput).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'General settings', exact: true }).click()
  await expect(
    tokens.getByRole('button', { name: 'Revoke Support reader', exact: true }),
  ).toBeVisible()
  await expect(secretInput).toHaveCount(0)
  await expect(tokens).not.toContainText(secret)
  await tokens.getByRole('button', { name: 'Revoke Support reader', exact: true }).click()
  await expect(tokens.getByText('Support reader · Revoked', { exact: true })).toBeVisible()
  expect(
    (
      await page.request.get('/api/v1/mailboxes', {
        headers: { authorization: `Bearer ${secret}` },
      })
    ).status(),
  ).toBe(401)
  await tokens.getByLabel('Token name', { exact: true }).fill('All-inbox reader')
  await tokens
    .getByRole('checkbox', { name: 'All current and future inboxes', exact: true })
    .check()
  await tokens.getByLabel('Expires', { exact: true }).selectOption('never')
  await tokens.getByRole('button', { name: 'Create token', exact: true }).click()
  await expect(secretInput).toBeVisible()
  await tokens.getByRole('button', { name: 'I saved the token', exact: true }).click()
  await expect(tokens.getByRole('listitem').filter({ hasText: 'All-inbox reader' })).toContainText(
    'Never expires',
  )
  const list = await (await page.request.get('/api/v1/auth/api-tokens')).json()
  expect(
    list.tokens.find((token: { name: string }) => token.name === 'All-inbox reader'),
  ).toMatchObject({ mailboxIds: null, expiresAt: null })
  await tokens
    .getByRole('button', { name: 'Revoke All-inbox reader', exact: true })
    .scrollIntoViewIfNeeded()
  await page.screenshot({ path: `/tmp/simple-inbox-api-tokens-qa/list-${info.project.name}.png` })
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  )
  expect(errors).toEqual([])
})
