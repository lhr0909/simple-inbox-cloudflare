import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

import { TEST_ADDRESSES, TEST_MAGIC_TOKEN } from '@cloudflare-inbox/test-harness'
import type { Locator, Page } from '@playwright/test'

import { expect, test } from './fixtures'

const EXPIRED_MAGIC_TOKEN = 'expired-magic-token-000000000000000000000000'
const SYNTHETIC_SUBJECT = 'Synthetic quarterly check-in'

test('exercises the authenticated inbox parity flow responsively', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  const unexpectedBrowserErrors = captureUnexpectedBrowserErrors(page)

  await page.goto('/sign-in')
  await expect(page).toHaveTitle('Sign in · Simple Inbox')
  await expect(page.getByRole('heading', { name: 'Sign in to your inbox' })).toBeVisible()
  await page.getByLabel('Email address').fill(TEST_ADDRESSES.owner)
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click()
  await expect(page.getByRole('status')).toContainText('Check your email')

  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  await expect(page).toHaveURL((url) => url.pathname === '/inbox')
  expect(new URL(page.url()).searchParams.has('token')).toBe(false)
  expect(page.url()).not.toContain(TEST_MAGIC_TOKEN)

  const threadList = page.getByTestId('thread-list')
  const threadButton = threadList.getByRole('button', {
    name: new RegExp(SYNTHETIC_SUBJECT, 'u'),
  })
  const search = page.getByRole('searchbox', { name: 'Search conversations' })
  const folders = page.getByRole('navigation', { name: 'Mailbox folders' })
  const unread = page.getByRole('button', { name: 'Unread', exact: true })

  await expect(threadList).toBeVisible()
  await expect(threadButton).toBeVisible()
  await expect(folders).toBeVisible()
  await expect(search).toBeVisible()
  await expect(unread).toHaveAttribute('aria-pressed', 'false')

  await search.fill('quarterly')
  await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('quarterly')
  await expect(threadButton).toBeVisible()

  await search.fill('no matching synthetic conversation')
  await expect
    .poll(() => new URL(page.url()).searchParams.get('q'))
    .toBe('no matching synthetic conversation')
  await expect(threadList.getByText('No conversations', { exact: true })).toBeVisible()

  await search.fill('')
  await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false)
  await expect(threadButton).toBeVisible()

  await unread.click()
  await expect.poll(() => new URL(page.url()).searchParams.has('unread')).toBe(true)
  await expect(unread).toHaveAttribute('aria-pressed', 'true')
  await expect(threadButton).toBeVisible()
  await unread.click()
  await expect.poll(() => new URL(page.url()).searchParams.has('unread')).toBe(false)

  await folders.getByRole('button', { name: /^Archive\b/u }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('folder')).toBe('archive')
  await expect(threadList.getByText('No conversations', { exact: true })).toBeVisible()
  await folders.getByRole('button', { name: /^All\b/u }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('folder')).toBe('all')
  await expect(threadButton).toBeVisible()

  await threadButton.focus()
  await expect(threadButton).toBeFocused()
  await page.keyboard.press('Enter')
  await expect.poll(() => new URL(page.url()).searchParams.has('thread')).toBe(true)

  const conversation = page.getByTestId('conversation-pane')
  await expect(conversation).toBeVisible()
  await expect(conversation.getByText(SYNTHETIC_SUBJECT, { exact: true })).toBeVisible()
  await expect(
    conversation.getByText('Hello from the deterministic integration fixture.'),
  ).toBeVisible()

  const singlePane = (page.viewportSize()?.width ?? 0) < 768
  const backToConversations = page.getByRole('button', { name: 'Back to conversations' })
  if (singlePane) {
    await expect(threadList).toBeHidden()
    await expect(backToConversations).toBeVisible()
  } else {
    await expect(threadList).toBeVisible()
    await expect(backToConversations).toBeHidden()
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true)

  await captureImplementationScreenshot(page, testInfo.project.name)

  if (testInfo.project.name === 'desktop-chromium') {
    const conversationResizeHandle = page.getByRole('separator', {
      name: 'Resize conversation list',
    })
    await expect(conversationResizeHandle).toHaveAttribute('aria-valuenow', '390')
    await conversationResizeHandle.focus()
    await page.keyboard.press('ArrowRight')
    await expect(conversationResizeHandle).toHaveAttribute('aria-valuenow', '406')
  }

  const attachmentLink = conversation.getByRole('link', { name: /synthetic-report\.txt/u })
  const rawEmailLink = conversation.getByRole('link', { name: 'Raw email', exact: true })
  await expect(attachmentLink).toBeVisible()
  await expect(rawEmailLink).toBeVisible()

  const attachmentUrl = await absoluteLink(attachmentLink, page.url())
  const rawEmailUrl = await absoluteLink(rawEmailLink, page.url())
  const attachmentResponse = await page.request.get(attachmentUrl)
  expect(attachmentResponse.status()).toBe(200)
  expect(attachmentResponse.headers()['content-disposition']).toContain('synthetic-report.txt')
  expect(await attachmentResponse.text()).toBe('Synthetic report content.\n')
  const rawEmailResponse = await page.request.get(rawEmailUrl)
  expect(rawEmailResponse.status()).toBe(200)
  expect(rawEmailResponse.headers()['content-type']).toContain('message/rfc822')
  expect(await rawEmailResponse.text()).toContain('Subject: Synthetic quarterly check-in')

  await conversation.getByRole('button', { name: 'Reply', exact: true }).click()
  const replyForm = page.locator('form').filter({
    has: page.getByRole('heading', { name: 'Reply', exact: true }),
  })
  await expect(replyForm).toBeVisible()
  const replyRecipient = replyForm.getByLabel('To', { exact: true })
  await expect(replyRecipient).toHaveValue(TEST_ADDRESSES.inboundSender)
  await replyRecipient.fill('reply-recipient@example.test')
  await expect(replyRecipient).toHaveValue('reply-recipient@example.test')
  await replyForm.getByLabel('Message', { exact: true }).fill('Synthetic draft reply.')
  await replyForm.getByLabel('Add attachments').setInputFiles({
    buffer: Buffer.from('Synthetic reply attachment.\n'),
    mimeType: 'text/plain',
    name: 'reply-note.txt',
  })
  await expect(replyForm.getByRole('list', { name: 'Attachments' })).toContainText('reply-note.txt')
  await expect(replyForm.getByRole('button', { name: 'Send reply' })).toBeEnabled()
  await replyForm.getByRole('button', { name: 'Send reply' }).click()
  await expect(replyForm).toContainText('Reply sent.')
  await expect(replyForm.getByLabel('Message', { exact: true })).toHaveValue('')
  await expect(conversation.getByText('Synthetic draft reply.', { exact: true })).toBeVisible()
  await expect(
    conversation.getByText('To: reply-recipient@example.test', { exact: true }),
  ).toBeVisible()
  await expect(
    conversation.getByRole('link', { name: 'reply-note.txt', exact: true }),
  ).toBeVisible()
  await replyForm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(replyForm).toBeHidden()

  await conversation.getByRole('button', { name: 'Archive', exact: true }).click()
  const restore = conversation.getByRole('button', { name: 'Restore', exact: true })
  await expect(restore).toBeVisible()
  await expect(restore).toBeEnabled()
  await restore.click()
  const archive = conversation.getByRole('button', { name: 'Archive', exact: true })
  await expect(archive).toBeVisible()
  await expect(archive).toBeEnabled()

  if (singlePane) {
    await backToConversations.click()
    await expect.poll(() => new URL(page.url()).searchParams.has('thread')).toBe(false)
  }
  await expect(threadList).toBeVisible()

  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  const composeDialog = page.getByRole('dialog', { name: 'New message' })
  await expect(composeDialog).toBeVisible()
  await composeDialog.getByLabel('To', { exact: true }).fill('recipient@example.test')
  await composeDialog.getByLabel('Subject', { exact: true }).fill('Synthetic unsent draft')
  await composeDialog.getByLabel('Message', { exact: true }).fill('This draft must not be sent.')
  await composeDialog.getByLabel('Add attachments').setInputFiles({
    buffer: Buffer.from('Synthetic compose attachment.\n'),
    mimeType: 'text/plain',
    name: 'compose-note.txt',
  })
  await expect(composeDialog.getByRole('list', { name: 'Attachments' })).toContainText(
    'compose-note.txt',
  )
  await expect(composeDialog.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await composeDialog.getByRole('button', { name: 'Remove compose-note.txt' }).click()
  await expect(composeDialog.getByRole('list', { name: 'Attachments' })).toHaveCount(0)
  await composeDialog.getByRole('button', { name: 'Close new message' }).click()
  await expect(composeDialog).toBeHidden()

  await page.getByRole('button', { name: /^(Mailbox settings|Settings)$/u }).click()
  const settingsDialog = page.getByRole('dialog', { name: 'Mailbox settings' })
  await expect(settingsDialog).toBeVisible()
  const senderAlias = settingsDialog.getByLabel('Sender alias')
  await expect(senderAlias).toHaveValue('Integration Inbox')
  await senderAlias.fill('Synthetic E2E Inbox')
  await expect(senderAlias).toHaveValue('Synthetic E2E Inbox')
  await expect(settingsDialog.getByLabel('Forward inbound mail to')).toHaveValue(
    TEST_ADDRESSES.owner,
  )
  await expect(settingsDialog.getByLabel('Color theme')).toHaveValue(/^(system|light|dark)$/u)
  await settingsDialog.getByRole('button', { name: 'Save settings' }).click()
  await expect(settingsDialog).toContainText('Settings saved.')
  await page.keyboard.press('Escape')
  await expect(settingsDialog).toBeHidden()

  await page.getByRole('button', { name: /^(Mailbox settings|Settings)$/u }).click()
  await expect(settingsDialog).toBeVisible()
  await expect(settingsDialog.getByLabel('Sender alias')).toHaveValue('Synthetic E2E Inbox')
  await settingsDialog.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  await expect(page.getByRole('heading', { name: 'Sign in to your inbox' })).toBeVisible()

  const unauthenticatedRaw = await page.request.get(rawEmailUrl)
  expect(unauthenticatedRaw.status()).toBe(401)
  await page.goto('/inbox?folder=all')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  await expect(page.getByTestId('thread-list')).toHaveCount(0)
  expectNoUnexpectedBrowserErrors(unexpectedBrowserErrors)
})

test('serves public documentation and a static search index', async ({ page }) => {
  const unexpectedBrowserErrors = captureUnexpectedBrowserErrors(page)

  await page.goto('/docs')
  await expect(page).toHaveTitle(/Simple Inbox/u)
  await expect(
    page.getByRole('heading', { level: 1, name: 'Simple Inbox', exact: true }),
  ).toBeVisible()

  const search = await page.request.get('/api/search')
  expect(search.status()).toBe(200)
  expect(search.headers()['content-type']).toContain('application/json')
  const index = await search.text()
  expect(index).toContain('Architecture')
  expect(index).toContain('/docs/architecture')
  expectNoUnexpectedBrowserErrors(unexpectedBrowserErrors)
})

test('removes an expired sign-in token from the visible URL', async ({ page }) => {
  const unexpectedBrowserErrors = captureUnexpectedBrowserErrors(page)

  await page.goto(`/auth/verify?token=${encodeURIComponent(EXPIRED_MAGIC_TOKEN)}`)
  await expect(page).toHaveURL((url) => {
    return (
      url.pathname === '/auth/verify' &&
      url.searchParams.get('error') === 'expired' &&
      !url.searchParams.has('token')
    )
  })
  expect(page.url()).not.toContain(EXPIRED_MAGIC_TOKEN)
  await expect(
    page.getByRole('heading', { name: 'This sign-in link is invalid or expired' }),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Return to sign in' })).toHaveAttribute(
    'href',
    '/sign-in',
  )
  expectNoUnexpectedBrowserErrors(unexpectedBrowserErrors)
})

function captureUnexpectedBrowserErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location()
      if (message.text().includes('404') && location.url.endsWith('/favicon.ico')) return
      const source = location.url ? ` (${location.url}:${location.lineNumber})` : ''
      errors.push(`console.error: ${message.text()}${source}`)
    }
  })
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`)
  })
  return errors
}

function expectNoUnexpectedBrowserErrors(errors: readonly string[]): void {
  expect(errors, `Unexpected browser errors:\n${errors.join('\n')}`).toEqual([])
}

async function absoluteLink(link: Locator, baseUrl: string): Promise<string> {
  const href = await link.getAttribute('href')
  expect(href).not.toBeNull()
  if (href === null) throw new Error('Expected the authenticated download to have an href.')
  return new URL(href, baseUrl).href
}

async function captureImplementationScreenshot(page: Page, project: string): Promise<void> {
  const directory = process.env['SIMPLE_INBOX_SCREENSHOT_DIR']
  const filename =
    project === 'desktop-chromium'
      ? 'simple-inbox-implementation-desktop.png'
      : project === 'mobile-chromium'
        ? 'simple-inbox-implementation-mobile.png'
        : null
  if (!directory || filename === null) return

  await mkdir(directory, { recursive: true })
  await page.screenshot({
    animations: 'disabled',
    path: resolve(directory, filename),
  })
}
