import {
  MAX_MESSAGE_PROJECTION_BODY_BYTES,
  MAX_RENDERED_TEXT_BYTES,
  PLAIN_TEXT_TRUNCATION_MARKER,
  messageProjectionBodyBytes,
} from '@cloudflare-inbox/mail-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseInboundMime } from '../src/services/mime'

const NOW = Date.UTC(2026, 7, 1, 5, 0, 0)
const encode = (value: string) => new TextEncoder().encode(value)

describe('hostile MIME projection limits', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('produces contract-readable bounded fields while the raw input remains independent', async () => {
    const consoleSpies = spyOnConsole()
    const to = recipientAddresses('to', 120)
    const cc = recipientAddresses('cc', 40)
    const bcc = [...recipientAddresses('bcc', 20), 'projection-secret-recipient@example.test']
    const replyTo = recipientAddresses('reply', 25)
    const references = [
      '<projection-secret-reference@example.test>',
      ...Array.from(
        { length: 130 },
        (_, index) => `<reference-${index.toString().padStart(3, '0')}@example.test>`,
      ),
    ]
    const boundary = 'bounded-projection-boundary'
    const raw = encode(
      [
        'From: Synthetic Sender <sender@example.test>',
        `To: ${[to[0]!.toUpperCase(), ...to].join(', ')}`,
        `Cc: ${[cc[0]!, ...cc].join(', ')}`,
        `Bcc: ${bcc.join(', ')}`,
        `Reply-To: ${replyTo.join(', ')}`,
        `References: ${references.join(' ')}`,
        `Subject: ${'😀'.repeat(600)} projection-secret-subject`,
        'Date: Fri, 01 Aug 2026 05:00:00 +0000',
        'Message-ID: <bounded-projection@example.test>',
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `${'"'.repeat(1_000_010)}projection-secret-body`,
        ...attachmentParts(boundary, 35),
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    )

    expect(raw.byteLength).toBeLessThanOrEqual(25 * 1_024 * 1_024)

    const parsed = await parseInboundMime(raw, NOW)
    const recipientCount =
      parsed.to.length + parsed.cc.length + parsed.bcc.length + parsed.replyTo.length

    expect(parsed.subject.length).toBeLessThanOrEqual(998)
    expect(parsed.text).toHaveLength(1_000_000)
    expect(parsed.html.length).toBeLessThanOrEqual(2_000_000)
    expect(messageProjectionBodyBytes(parsed)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
    expect(parsed.html).toMatch(/^<p>.*<\/p>$/su)
    expect(recipientCount).toBe(200)
    expect(parsed.to).toHaveLength(120)
    expect(parsed.to.map(({ address }) => address)).toEqual(to)
    expect(parsed.cc).toHaveLength(40)
    expect(parsed.replyTo.map(({ address }) => address)).toEqual(replyTo)
    expect(parsed.bcc.map(({ address }) => address)).toEqual(bcc.slice(0, 15))
    expect(parsed.references).toHaveLength(100)
    expect(parsed.references[0]).toBe('<reference-030@example.test>')
    expect(parsed.references.at(-1)).toBe('<reference-129@example.test>')
    expect(parsed.attachments).toHaveLength(32)
    expect(
      new TextEncoder().encode(parsed.attachments[0]?.filename).byteLength,
    ).toBeLessThanOrEqual(180)
    expect(parsed.attachments[0]?.contentId?.length).toBeLessThanOrEqual(500)
    expect(parsed.attachments[0]?.mediaType).toBe('application/octet-stream')

    const projection = JSON.stringify(parsed)
    expect(projection).not.toContain('projection-secret')
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('derives inert readable text from HTML-only messages without remote or active content', async () => {
    const consoleSpies = spyOnConsole()
    const raw = encode(
      [
        'From: Synthetic Sender <sender@example.test>',
        'To: support@example.test',
        'Subject: HTML-only synthetic fixture',
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<!doctype html>',
        '<html><head>',
        '<style>body{background:url(https://style-remote.example.test/style-secret)}</style>',
        '<script src="https://script-remote.example.test/source-secret">script-secret()</script>',
        '</head><body>',
        '<!-- comment-secret -->',
        '<h1>Quarterly &amp; check-in</h1>',
        '<p>Amount &#36;5 &#x1F642;</p>',
        '<img src="https://pixel-remote.example.test/pixel-secret" onerror="handler-secret">',
        '<a href="https://link-remote.example.test/link-secret">Read safely</a>',
        '<script>inline-script-secret()</SCRIPT >',
        '<script/>self-closing-script-secret</script>',
        '<style>.hidden::after{content:"inline-style-secret"}</STYLE >',
        '<div>Second<br>line</div>',
        '</body></html>',
      ].join('\r\n'),
    )

    const parsed = await parseInboundMime(raw, NOW)

    expect(parsed.text).toContain('Quarterly & check-in')
    expect(parsed.text).toContain('Amount $5 🙂')
    expect(parsed.text).toContain('Read safely')
    expect(parsed.text).toContain('Second\nline')
    expect(parsed.html).toContain('Quarterly &amp; check-in')
    expect(parsed.html).not.toMatch(/<(?:img|script|style|a)\b/iu)
    for (const secret of [
      'style-remote.example.test',
      'script-remote.example.test',
      'pixel-remote.example.test',
      'link-remote.example.test',
      'comment-secret',
      'script-secret',
      'style-secret',
      'handler-secret',
    ]) {
      expect(parsed.text).not.toContain(secret)
      expect(parsed.html).not.toContain(secret)
    }
    expect(consoleSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
  })

  it('bounds multibyte MIME projections by encoded bytes rather than UTF-16 length', async () => {
    const raw = encode(
      [
        'From: Synthetic Sender <sender@example.test>',
        'To: support@example.test',
        'Subject: Multibyte synthetic fixture',
        'Content-Type: text/plain; charset=utf-8',
        '',
        '😀'.repeat(250_100),
      ].join('\r\n'),
    )

    const parsed = await parseInboundMime(raw, NOW)

    expect(parsed.text.length).toBeLessThan(1_000_000)
    expect(encode(parsed.text).byteLength).toBeLessThanOrEqual(MAX_RENDERED_TEXT_BYTES)
    expect(parsed.text).not.toContain('\ufffd')
    expect(parsed.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(true)
    expect(parsed.html).not.toContain('\ufffd')
    expect(parsed.html.endsWith(`<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`)).toBe(true)
    expect(messageProjectionBodyBytes(parsed)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
  })
})

function recipientAddresses(prefix: string, count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${prefix}-${index.toString().padStart(3, '0')}@example.test`,
  )
}

function attachmentParts(boundary: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const isFirst = index === 0
    const isOutsideProjection = index === 32
    const filename = isFirst
      ? `${'f'.repeat(600)}.txt`
      : isOutsideProjection
        ? 'projection-secret-attachment.txt'
        : `synthetic-${index.toString().padStart(2, '0')}.txt`
    const contentId = isFirst
      ? `<content-${'i'.repeat(600)}@example.test>`
      : `<content-${index}@example.test>`
    return [
      `--${boundary}`,
      `Content-Type: ${isFirst ? `application/${'x'.repeat(300)}` : 'text/plain'}; name="${filename}"`,
      `Content-Disposition: attachment; filename="${filename}"`,
      `Content-ID: ${contentId}`,
      'Content-Transfer-Encoding: base64',
      '',
      'eA==',
    ].join('\r\n')
  })
}

function spyOnConsole() {
  return [
    vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
    vi.spyOn(console, 'info').mockImplementation(() => undefined),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
  ]
}
