import { TEST_ADDRESSES, TEST_SETUP_TOKEN } from '@cloudflare-inbox/test-harness'
import type { Page } from '@playwright/test'

import { expect, test } from './setup-fixtures'

test('completes the four-step fresh-install setup flow', async ({ page }) => {
  const unexpectedBrowserErrors = captureUnexpectedBrowserErrors(page)

  await page.goto('/')
  await expect(page).toHaveURL((url) => url.pathname === '/setup')
  await expect(page).toHaveTitle('Set up · Simple Inbox')
  await expect(page.getByRole('heading', { name: 'Secure this installation' })).toBeVisible()
  await expect(page.getByText('Step 1 of 4', { exact: true })).toBeVisible()

  await page.getByLabel('Setup token').fill(TEST_SETUP_TOKEN)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Create your first mailbox' })).toBeVisible()
  await expect(page.getByText('Step 2 of 4', { exact: true })).toBeVisible()
  await page.getByLabel('Owner email').fill(TEST_ADDRESSES.owner)
  await page.getByLabel('Mail domain').fill('example.test')
  await page.getByLabel('Inbox address').fill(TEST_ADDRESSES.mailbox)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Choose retention windows' })).toBeVisible()
  await expect(page.getByText('Step 3 of 4', { exact: true })).toBeVisible()
  await page.getByLabel('Raw email').fill('30')
  await page.getByLabel('Inbox records').fill('90')
  await page.getByLabel('Cleanup batch size').fill('100')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Review your setup' })).toBeVisible()
  await expect(page.getByText('Step 4 of 4', { exact: true })).toBeVisible()
  await expect(page.getByText(TEST_ADDRESSES.owner, { exact: true })).toBeVisible()
  await expect(page.getByText(TEST_ADDRESSES.mailbox, { exact: true })).toBeVisible()
  await expect(page.getByText('example.test', { exact: true })).toBeVisible()
  await expect(page.getByText('30 days raw · 90 days searchable', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Verify your sending domain in Cloudflare Email Sending.', { exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Point an Email Routing address or catch-all at this Worker.', { exact: true }),
  ).toBeVisible()

  await page.getByRole('button', { name: 'Finish setup', exact: true }).click()

  await expect(page.getByText('Installation complete', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your inbox is configured' })).toBeVisible()
  await expect(page.getByText(TEST_ADDRESSES.mailbox, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
    'href',
    '/sign-in',
  )
  await expect(page.getByRole('link', { name: 'Activation guide' })).toHaveAttribute(
    'href',
    '/docs/deployment',
  )

  await page.goto('/')
  await expect(page).toHaveURL((url) => url.pathname === '/sign-in')
  await expect(page).toHaveTitle('Sign in · Simple Inbox')
  await expect(page.getByRole('heading', { name: 'Sign in to your inbox' })).toBeVisible()
  expect(page.url()).not.toContain(TEST_SETUP_TOKEN)
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
