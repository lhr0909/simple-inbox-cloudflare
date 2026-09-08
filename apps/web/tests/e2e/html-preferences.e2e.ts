import { expect, test as base } from '@playwright/test'
import {
  injectSyntheticInbound,
  migrateAndSeedHarness,
  startInboxTestHarness,
  TEST_IDS,
  TEST_MAGIC_TOKEN,
  type InboxTestHarness,
} from '@cloudflare-inbox/test-harness'

const test = base.extend<{ htmlHarness: InboxTestHarness }>({
  htmlHarness: async ({ browserName }, use) => {
    void browserName
    const harness = await startInboxTestHarness()
    try {
      await migrateAndSeedHarness(harness)
      await use(harness)
    } finally {
      await harness.close()
    }
  },
  baseURL: async ({ htmlHarness }, use) => use(htmlHarness.origin),
})

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII='

test('persists independent HTML preferences and safely renders retained mail on every viewport', async ({
  page,
  htmlHarness,
}) => {
  await injectSyntheticInbound(
    htmlHarness,
    [
      'From: sender@example.test',
      'To: inbox@example.test',
      'Subject: HTML settings example',
      'Message-ID: <html-settings@example.test>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="html-preview"',
      '',
      '--html-preview',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<style>.offer{color:rgb(180, 30, 50)}</style>',
      '<table><tr><td><h1 class="offer">Formatted greeting</h1><p><strong>Important update</strong></p>',
      '<img src="cid:logo" alt="Inline logo"><img src="https://images.example.test/pixel.png" alt="Remote logo">',
      '<script>parent.__emailCompromised=true</script><img src="invalid:" onerror="parent.__emailCompromised=true">',
      '<form action="https://blocked.example.test/form"><input autofocus onfocus="parent.__emailCompromised=true"></form>',
      '<iframe src="https://blocked.example.test/frame"></iframe><meta http-equiv="refresh" content="0;url=https://blocked.example.test/refresh">',
      '<a href="https://example.test/details" target="_top">Read details</a></td></tr></table>',
      '--html-preview',
      'Content-Type: image/png',
      'Content-ID: <logo>',
      'Content-Disposition: inline; filename="logo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      PNG,
      '--html-preview--',
      '',
    ].join('\r\n'),
  )

  let remoteImages = 0
  const blockedRequests: string[] = []
  await page.route('https://images.example.test/**', async (route) => {
    remoteImages++
    await route.fulfill({ body: Buffer.from(PNG, 'base64'), contentType: 'image/png' })
  })
  await page.route('https://blocked.example.test/**', async (route) => {
    blockedRequests.push('unexpected active content request')
    await route.abort()
  })
  await page.goto(`/auth/verify?token=${encodeURIComponent(TEST_MAGIC_TOKEN)}`)
  await page
    .getByTestId('thread-list')
    .getByRole('button', { name: /HTML settings example/u })
    .click()
  await expect(page.getByTestId('conversation-pane')).toContainText('Formatted greeting')
  await expect(page.getByTitle('HTML email')).toHaveCount(0)
  expect(remoteImages).toBe(0)

  const mobile = (page.viewportSize()?.width ?? 0) < 768
  const openSettings = async () => {
    if (mobile) await page.getByRole('button', { name: 'Back to conversations' }).click()
    await page.getByRole('button', { name: /^(Mailbox settings|Settings)$/u }).click()
  }
  await openSettings()
  const dialog = page.getByRole('dialog', { name: 'Mailbox settings' })
  const forward = dialog.getByRole('checkbox', { name: 'Forward full HTML', exact: true })
  const render = dialog.getByRole('checkbox', { name: 'Display full HTML in inbox', exact: true })
  await expect(forward).toBeChecked()
  await expect(render).not.toBeChecked()
  await forward.uncheck()
  await dialog.getByRole('button', { name: 'Save settings' }).click()
  await expect(dialog.getByRole('status')).toContainText('Settings saved')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await page.reload()
  await page.getByRole('button', { name: /^(Mailbox settings|Settings)$/u }).click()
  await expect(forward).not.toBeChecked()
  await expect(render).not.toBeChecked()
  await forward.check()
  await render.check()
  await dialog.getByRole('button', { name: 'Save settings' }).click()
  await expect(dialog.getByRole('status')).toContainText('Settings saved')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  if (mobile)
    await page
      .getByTestId('thread-list')
      .getByRole('button', { name: /HTML settings example/u })
      .click()

  const frame = page.frameLocator('iframe[title="HTML email"]')
  await expect(frame.getByRole('heading', { name: 'Formatted greeting' })).toHaveCSS(
    'color',
    'rgb(180, 30, 50)',
  )
  await expect.poll(() => remoteImages).toBeGreaterThan(0)
  await expect(frame.getByAltText('Inline logo')).toHaveJSProperty('naturalWidth', 1)
  await expect(frame.getByAltText('Remote logo')).toHaveJSProperty('naturalWidth', 1)
  await expect(frame.locator('form, input, iframe, meta[http-equiv="refresh"]')).toHaveCount(0)
  await expect(frame.getByRole('link', { name: 'Read details' })).toHaveAttribute(
    'target',
    '_blank',
  )
  expect(await page.evaluate(() => Reflect.get(window, '__emailCompromised'))).toBeUndefined()
  expect(
    await frame.locator('body').evaluate(() => {
      try {
        void window.parent.document
        return false
      } catch {
        return true
      }
    }),
  ).toBe(true)
  expect(blockedRequests).toEqual([])
  await expect(page.getByTitle('HTML email')).not.toHaveAttribute('sandbox', /allow-same-origin/u)
  const htmlUrl = await page.getByTitle('HTML email').getAttribute('src')
  const response = await page.request.get(htmlUrl!)
  expect(response.headers()['content-security-policy']).toContain("frame-ancestors 'self'")
  expect(response.headers()['content-security-policy']).toContain('sandbox allow-scripts')
  expect(response.headers()['x-frame-options']).toBe('SAMEORIGIN')
  expect(response.headers()['cache-control']).toBe('private, no-store')

  await page.getByRole('button', { name: 'Show plain text' }).click()
  await expect(page.getByTitle('HTML email')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show HTML' }).click()
  await expect(frame.getByRole('heading', { name: 'Formatted greeting' })).toBeVisible()
  await openSettings()
  await render.uncheck()
  await dialog.getByRole('button', { name: 'Save settings' }).click()
  await expect(dialog.getByRole('status')).toContainText('Settings saved')
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  if (mobile)
    await page
      .getByTestId('thread-list')
      .getByRole('button', { name: /HTML settings example/u })
      .click()
  await expect(page.getByTitle('HTML email')).toHaveCount(0)
  expect((await page.request.get(htmlUrl!)).status()).toBe(404)
  const settings = await page.request.get('/api/v1/mailboxes')
  expect(
    (await settings.json()).mailboxes.find((m: { id: string }) => m.id === TEST_IDS.mailbox),
  ).toMatchObject({ forwardHtml: true, renderHtml: false })
})
