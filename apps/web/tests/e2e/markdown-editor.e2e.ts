import { mkdir } from 'node:fs/promises'
import { crc32, deflateSync } from 'node:zlib'
import { expect, test as base } from '@playwright/test'
import {
  TEST_MAGIC_TOKEN,
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
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ inboxHarness }, use) => use(inboxHarness.origin),
})

function screenshotFixture(): Buffer {
  const width = 480,
    height = 240
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const pixels = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const index = y * (1 + width * 3) + 1 + x * 3
      const highlight = x > 28 && x < width - 28 && y > 65 && y < 190
      pixels[index] = highlight ? 219 : 37
      pixels[index + 1] = highlight ? 234 : 99
      pixels[index + 2] = highlight ? 254 : 235
    }
  function chunk(name: string, data: Buffer) {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, crc])
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('previews Markdown, embeds uploaded images, preserves drafts, and sends from the preview tab', async ({
  page,
  inboxHarness,
}, info) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await page.goto(`/auth/verify?token=${TEST_MAGIC_TOKEN}`)
  await expect(page).toHaveURL((url) => url.pathname === '/inbox')
  await expect(page).toHaveTitle(/Inbox/u)
  await page.getByRole('button', { name: 'Compose', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New message' })
  await dialog.getByLabel('To', { exact: true }).fill('customer@example.test')
  await dialog.getByLabel('Subject', { exact: true }).fill('Illustrated support instructions')
  const body = dialog.getByLabel('Message', { exact: true })
  await body.fill(
    '## Restore your receipts\n\nOpen **Settings**, then choose _Restore_.\n\n1. Select your backup.\n2. Check the receipt count.\n\n',
  )
  await dialog.getByLabel('Add attachments').setInputFiles([
    { name: 'settings.png', mimeType: 'image/png', buffer: screenshotFixture() },
    { name: 'guide.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic support guide.') },
  ])
  const files = dialog.getByRole('list', { name: 'Attachments' })
  await expect(files.getByText('Ready to send', { exact: true })).toHaveCount(2)
  await body.focus()
  await body.press('ControlOrMeta+End')
  await files.getByRole('button', { name: 'Insert image', exact: true }).click()
  await files
    .getByRole('listitem')
    .filter({ hasText: 'guide.txt' })
    .getByRole('button', { name: 'Insert link', exact: true })
    .click()
  const draft = await body.inputValue()
  expect(draft).toContain('![settings.png](attachment:')
  expect(draft).toContain('[guide.txt](attachment:')
  await dialog.getByRole('tab', { name: 'Preview', exact: true }).click()
  const preview = dialog.frameLocator('iframe[title="Email preview"]')
  await expect(preview.getByRole('heading', { name: 'Restore your receipts' })).toBeVisible()
  await expect(preview.locator('strong')).toHaveText('Settings')
  const image = preview.getByRole('img', { name: 'settings.png' })
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(480)
  expect(
    await preview.locator('body').evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain('Arial')
  await expect(preview.getByRole('link', { name: 'guide.txt', exact: true })).toHaveCount(2)
  await mkdir('/tmp/simple-inbox-markdown-qa', { recursive: true })
  await dialog.locator('iframe').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `/tmp/simple-inbox-markdown-qa/editor-${info.project.name}.png` })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
  await dialog.getByRole('tab', { name: 'Plain text', exact: true }).click()
  const plain = await dialog.getByRole('tabpanel').innerText()
  expect(plain).toContain('Open Settings, then choose Restore.')
  expect(plain).not.toMatch(/##|\*\*|attachment:|blob:/u)
  await dialog.getByRole('tab', { name: 'Write', exact: true }).click()
  await expect(body).toHaveValue(draft)
  // Removing a referenced file must block delivery until its Markdown reference is removed.
  await files.getByRole('button', { name: 'Remove guide.txt', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('attachment is missing')
  await expect(dialog.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await body.fill(draft.replace(/\[guide\.txt\]\(attachment:[^)]+\)/u, ''))
  await dialog.getByRole('tab', { name: 'Preview', exact: true }).click()
  await dialog.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(dialog.getByText('Message sent.', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()

  // A minimally styled Gmail-like reply should inherit the preview's typography and padding.
  await injectSyntheticInbound(
    inboxHarness,
    [
      'From: sender@example.test',
      'To: inbox@example.test',
      'Subject: Minimal HTML support reply',
      'Message-ID: <minimal-html@example.test>',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<div>Hello from a minimally styled support reply.</div><blockquote>Earlier conversation.</blockquote>',
    ].join('\r\n'),
  )
  await page.goto('/inbox')
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /Minimal HTML support reply/u })
    .click()
  await page.getByRole('button', { name: 'Show HTML', exact: true }).click()
  const received = page.frameLocator('iframe[title="HTML email"]')
  await expect(received.getByText('Hello from a minimally styled support reply.')).toBeVisible()
  expect(
    await received.locator('body').evaluate((element) => getComputedStyle(element).fontFamily),
  ).toContain('Arial')
  expect(
    await received.locator('body').evaluate((element) => getComputedStyle(element).padding),
  ).toBe('20px')
  await page.screenshot({ path: `/tmp/simple-inbox-markdown-qa/received-${info.project.name}.png` })
  // Reply uses the same editor and preview while preserving its draft across tabs.
  await page
    .getByTestId('conversation-pane')
    .getByRole('button', { name: 'Reply', exact: true })
    .click()
  const reply = page
    .locator('form')
    .filter({ has: page.getByRole('heading', { name: 'Reply', exact: true }) })
  await reply.getByLabel('Message', { exact: true }).fill('**Thanks** for the screenshot.')
  await reply.getByRole('tab', { name: 'Preview', exact: true }).click()
  await expect(reply.frameLocator('iframe').locator('strong')).toHaveText('Thanks')
  await reply.getByRole('tab', { name: 'Write', exact: true }).click()
  await expect(reply.getByLabel('Message', { exact: true })).toHaveValue(
    '**Thanks** for the screenshot.',
  )
  expect(errors).toEqual([])
})
