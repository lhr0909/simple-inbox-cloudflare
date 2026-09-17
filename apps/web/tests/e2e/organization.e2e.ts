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
  await page.getByRole('button', { name: 'Create inbox for this mailbox' }).click()
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
  await page.getByRole('button', { name: 'General settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'General settings', exact: true })
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
  await expect(conversation).toContainText('Blocked mailbox')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  )
  await mkdir('/tmp/simple-inbox-qa', { recursive: true })
  await page.screenshot({
    path: `/tmp/simple-inbox-qa/spam-${info.project.name}.png`,
    fullPage: false,
  })
  await conversation.getByRole('button', { name: 'Not spam', exact: true }).click()
  await expect(conversation.getByText('Blocked mailbox', { exact: true })).toHaveCount(0)
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

for (const kind of ['sender', 'domain'] as const) {
  test(`Spam confirmation blocks the selected ${kind} and future matching mail`, async ({
    page,
    organizationHarness: harness,
  }, info) => {
    const sender = 'sender@senders.example.test'
    const recipient = 'inbox@example.test'
    const incoming = (id: string, subject: string, from = sender, headers: string[] = []) =>
      mail(recipient, id, subject, headers).replace(
        'From: sender@example.test',
        `From: Named sender <${from}>`,
      )
    await harness.worker.email({
      from: sender,
      to: recipient,
      raw: incoming('spam-dialog', 'Spam confirmation review'),
    })
    if (kind === 'sender') {
      await harness.worker.email({
        from: 'colleague@colleagues.example.test',
        to: recipient,
        raw: incoming(
          'spam-colleague',
          'Re: Spam confirmation review',
          'colleague@colleagues.example.test',
          ['In-Reply-To: <spam-dialog@example.test>', 'References: <spam-dialog@example.test>'],
        ),
      })
    }
    await page.goto(`/auth/verify?token=${TEST_MAGIC_TOKEN}`)
    await page
      .getByTestId('thread-list')
      .getByRole('button', { name: /Spam confirmation review/ })
      .click()
    const conversation = page.getByTestId('conversation-pane')
    // A later sent reply must never select our own address as the sender to block.
    await conversation.getByRole('button', { name: 'Reply', exact: true }).click()
    const reply = page
      .locator('form')
      .filter({ has: page.getByRole('heading', { name: 'Reply', exact: true }) })
    await reply.getByLabel('Message', { exact: true }).fill('Synthetic reply before blocking.')
    await reply.getByRole('button', { name: 'Send reply' }).click()
    await expect(reply).toContainText('Reply sent.')
    await reply.getByRole('button', { name: 'Cancel', exact: true }).click()
    const threadId = new URL(page.url()).searchParams.get('thread')!
    await conversation.getByRole('button', { name: 'Spam', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Move to Spam and block sender' })
    await expect(dialog.getByRole('radio', { name: /This email address/ })).toBeChecked()
    if (kind === 'sender') {
      await expect(dialog.getByLabel('Sender to block')).toHaveValue(
        'colleague@colleagues.example.test',
      )
      await dialog.getByLabel('Sender to block').selectOption(sender)
    }
    await expect(dialog).toContainText(sender)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    expect((await (await page.request.get('/api/v1/spam-rules')).json()).rules).toEqual([])
    expect(
      (await (await page.request.get(`/api/v1/threads/${threadId}`)).json()).thread.hasSpam,
    ).toBe(false)
    await conversation.getByRole('button', { name: 'Spam', exact: true }).click()
    if (kind === 'sender') await dialog.getByLabel('Sender to block').selectOption(sender)
    if (kind === 'domain') await dialog.getByRole('radio', { name: /Entire email domain/ }).check()
    await mkdir('/tmp/simple-inbox-qa', { recursive: true })
    await page.screenshot({ path: `/tmp/simple-inbox-qa/block-${kind}-${info.project.name}.png` })
    await dialog.getByRole('button', { name: 'Block and move to Spam' }).click()
    await expect(dialog).not.toBeVisible()
    await expect(conversation.getByRole('button', { name: 'Not spam', exact: true })).toBeVisible()
    await expect(conversation.getByText('Marked as spam', { exact: true }).first()).toBeVisible()
    await expect(conversation.getByText('Spam · Marked as spam', { exact: true })).toHaveCount(0)
    const rules = (await (await page.request.get('/api/v1/spam-rules')).json()).rules
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({
      kind,
      value: kind === 'sender' ? sender : 'senders.example.test',
    })
    const laterSender = kind === 'domain' ? 'different@sub.senders.example.test' : sender
    await harness.worker.email({
      from: laterSender,
      to: recipient,
      raw: incoming('blocked-later', 'Future blocked mail', laterSender),
    })
    const mailboxId = new URL(page.url()).searchParams.get('mailbox')!
    const spam = await (
      await page.request.get(`/api/v1/threads?mailboxId=${mailboxId}&folder=spam`)
    ).json()
    const blocked = spam.items.find(
      (thread: { subject: string }) => thread.subject === 'Future blocked mail',
    )
    expect(blocked).toBeTruthy()
    const detail = await (await page.request.get(`/api/v1/threads/${blocked.id}`)).json()
    expect(detail.messages[0]).toMatchObject({
      forwardState: 'not_applicable',
      spamReason: `blacklist_${kind}`,
    })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true,
    )
  })
}

for (const scope of ['inbox', 'other'] as const) {
  test(`blocks a receiving mailbox in one click from ${scope}`, async ({
    page,
    organizationHarness: harness,
  }, info) => {
    const recipient = scope === 'other' ? 'unused@example.test' : 'inbox@example.test'
    await harness.worker.email({
      from: 'sender@example.test',
      to: recipient,
      raw: mail('inbox@example.test', 'mailbox-block', 'Block receiving mailbox'),
    })
    await page.goto(`/auth/verify?token=${TEST_MAGIC_TOKEN}`)
    if (scope === 'other') {
      await page
        .getByRole('combobox', { name: 'Mailbox', exact: true })
        .filter({ visible: true })
        .selectOption('other')
      await expect(page).toHaveURL((url) => url.searchParams.get('mailbox') === 'other')
    }
    await page
      .getByTestId('thread-list')
      .getByRole('button', { name: /Block receiving mailbox/ })
      .click()
    const pane = page.getByTestId('conversation-pane')
    await expect(pane).toContainText(`Received at ${recipient}`)
    await pane.getByRole('button', { name: 'Block mailbox', exact: true }).click()
    await expect(pane.getByRole('button', { name: 'Not spam', exact: true })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const rules = (await (await page.request.get('/api/v1/spam-rules')).json()).rules
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ kind: 'recipient', value: recipient })
    await harness.worker.email({
      from: 'different@example.test',
      to: recipient,
      raw: mail(recipient, 'mailbox-later', 'Future mailbox spam').replace(
        'From: sender@example.test',
        'From: different@example.test',
      ),
    })
    const mailboxScope = new URL(page.url()).searchParams.get('mailbox')!
    const spam = await (
      await page.request.get(`/api/v1/threads?mailboxId=${mailboxScope}&folder=spam`)
    ).json()
    const future = spam.items.find(
      (thread: { subject: string }) => thread.subject === 'Future mailbox spam',
    )
    expect(future).toBeTruthy()
    const detail = await (await page.request.get(`/api/v1/threads/${future.id}`)).json()
    expect(detail.messages[0]).toMatchObject({
      spamReason: 'blacklist_recipient',
      forwardState: 'not_applicable',
    })
    if ((page.viewportSize()?.width ?? 0) < 768)
      await page.getByRole('button', { name: 'Back to conversations' }).click()
    await page.getByRole('button', { name: 'General settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'General settings', exact: true })
    await expect(settings.getByRole('listitem').filter({ hasText: recipient })).toContainText(
      'Mailbox',
    )
    await expect(settings.getByRole('option', { name: 'Mailbox', exact: true })).toHaveCount(1)
    await mkdir('/tmp/simple-inbox-qa', { recursive: true })
    await page.screenshot({
      path: `/tmp/simple-inbox-qa/mailbox-blacklist-${scope}-${info.project.name}.png`,
    })
  })
}
