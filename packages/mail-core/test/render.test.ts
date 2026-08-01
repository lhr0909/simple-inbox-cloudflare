import { describe, expect, it } from 'vitest'

import {
  MAX_MESSAGE_PROJECTION_BODY_BYTES,
  MAX_RENDERED_HTML_CHARACTERS,
  MAX_RENDERED_HTML_BYTES,
  MAX_RENDERED_TEXT_CHARACTERS,
  MAX_RENDERED_TEXT_BYTES,
  PLAIN_TEXT_TRUNCATION_MARKER,
  markdownToPlainText,
  messageProjectionBodyBytes,
  renderMarkdownToSafeHtml,
  renderPlainTextToSafeHtml,
  renderSafeMessageContent,
} from '../src/render'

describe('safe body rendering', () => {
  it('escapes every HTML-significant character in plain text', () => {
    expect(renderPlainTextToSafeHtml('<img src=x onerror="alert(1)"> & hi')).toBe(
      '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; hi</p>',
    )
  })

  it('never renders arbitrary inbound HTML or remote images', () => {
    expect(
      renderSafeMessageContent({
        source: 'inbound',
        text: 'Safe fallback',
        markdown: '**must not render**',
        html: '<script>alert(1)</script><img src="https://tracker.test/pixel">',
      }),
    ).toEqual({ text: 'Safe fallback', html: '<p>Safe fallback</p>' })
  })

  it('renders a bounded app Markdown subset and safe links', () => {
    const html = renderMarkdownToSafeHtml(
      '# Hello\n\n**Bold** and `code`\n\n- one\n- two\n\n[site](https://example.test) [bad](javascript:alert(1))',
    )
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>')
    expect(html).toContain('href="https://example.test"')
    expect(html).not.toContain('javascript:')
  })

  it('escapes raw tags and event handlers even in app Markdown', () => {
    const html = renderMarkdownToSafeHtml(
      '<img src=x onerror=alert(1)> **<script>alert(2)</script>**',
    )
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
  })

  it('repairs crossed Markdown emphasis into structurally valid safe HTML', () => {
    const rendered = renderSafeMessageContent({ source: 'app', markdown: '**_crossed**_' })

    expect(rendered.html).toBe('<p><strong><em>crossed</em></strong></p>')
    expectValidGeneratedHtml(rendered.html)
  })

  it('produces a useful plain-text fallback from Markdown', () => {
    expect(markdownToPlainText('# Hello\n\n- **One**\n- [Two](https://two.test)')).toBe(
      'Hello\n\nOne\nTwo (https://two.test)',
    )
    expect(renderSafeMessageContent({ source: 'app', markdown: '**Hello**' })).toEqual({
      text: 'Hello',
      html: '<p><strong>Hello</strong></p>',
    })
  })

  it('bounds worst-case plain-text escaping without splitting entities or markup', () => {
    const rendered = renderSafeMessageContent({
      source: 'inbound',
      text: '&'.repeat(MAX_RENDERED_TEXT_CHARACTERS + 100),
    })

    expect(rendered.text.length).toBeLessThanOrEqual(MAX_RENDERED_TEXT_CHARACTERS)
    expect(byteLength(rendered.text)).toBeLessThanOrEqual(MAX_RENDERED_TEXT_BYTES)
    expect(rendered.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(true)
    expect(rendered.html.length).toBeLessThanOrEqual(MAX_RENDERED_HTML_CHARACTERS)
    expect(byteLength(rendered.html)).toBeLessThanOrEqual(MAX_RENDERED_HTML_BYTES)
    expect(messageProjectionBodyBytes(rendered)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
    expect(messageProjectionBodyBytes(rendered)).toBeGreaterThan(
      MAX_MESSAGE_PROJECTION_BODY_BYTES - 10,
    )
    expect(rendered.html).toContain('&amp;&amp;&amp;')
    expect(rendered.html.endsWith(`<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`)).toBe(true)
    expectValidGeneratedHtml(rendered.html)
  })

  it('bounds large Markdown while keeping generated tags, entities, and links safe', () => {
    const block = '# **<&"\'>**\n\n- `&&`\n- [safe & label](https://example.test/a?one=1&two=2)\n\n'
    const markdown = block.repeat(
      Math.ceil((MAX_RENDERED_TEXT_CHARACTERS + block.length) / block.length),
    )
    const rendered = renderSafeMessageContent({ source: 'app', markdown })

    expect(rendered.text.length).toBeLessThanOrEqual(MAX_RENDERED_TEXT_CHARACTERS)
    expect(byteLength(rendered.text)).toBeLessThanOrEqual(MAX_RENDERED_TEXT_BYTES)
    expect(rendered.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(true)
    expect(rendered.html.length).toBeLessThanOrEqual(MAX_RENDERED_HTML_CHARACTERS)
    expect(byteLength(rendered.html)).toBeLessThanOrEqual(MAX_RENDERED_HTML_BYTES)
    expect(messageProjectionBodyBytes(rendered)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
    expect(rendered.html.endsWith(`<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`)).toBe(true)
    expect(rendered.html).toContain('<h1><strong>')
    expect(rendered.html).toContain('href="https://example.test/a?one=1&amp;two=2"')
    expect(rendered.html).not.toContain('<script')
    expect(rendered.html).not.toContain('javascript:')
    expectValidGeneratedHtml(rendered.html)
  })

  it('does not split a Unicode code point at the plain-text boundary', () => {
    const markerWithSeparator = `\n\n${PLAIN_TEXT_TRUNCATION_MARKER}`
    const prefixCapacity = MAX_RENDERED_TEXT_CHARACTERS - markerWithSeparator.length
    const rendered = renderSafeMessageContent({
      source: 'inbound',
      text: `${'a'.repeat(prefixCapacity - 1)}😀tail that must be truncated`,
    })

    expect(rendered.text.length).toBeLessThanOrEqual(MAX_RENDERED_TEXT_CHARACTERS)
    expect(rendered.text.slice(0, -markerWithSeparator.length)).not.toMatch(/[\ud800-\udbff]$/u)
    expect(rendered.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(true)
    expectValidGeneratedHtml(rendered.html)
  })

  it('bounds multibyte text and its HTML alternative by UTF-8 bytes', () => {
    const rendered = renderSafeMessageContent({
      source: 'inbound',
      // This is below the public character limit but above the persisted byte limit.
      text: `${'😀'.repeat(250_100)}tail`,
    })

    expect(rendered.text.length).toBeLessThan(MAX_RENDERED_TEXT_CHARACTERS)
    expect(byteLength(rendered.text)).toBeLessThanOrEqual(MAX_RENDERED_TEXT_BYTES)
    expect(rendered.text).not.toContain('\ufffd')
    expect(rendered.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(true)
    expect(byteLength(rendered.html)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES - byteLength(rendered.text),
    )
    expect(rendered.html).not.toContain('\ufffd')
    expect(rendered.html.endsWith(`<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`)).toBe(true)
    expect(messageProjectionBodyBytes(rendered)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
    expectValidGeneratedHtml(rendered.html)
  })

  it('dynamically gives HTML only the bytes remaining in the combined row budget', () => {
    const rendered = renderSafeMessageContent({
      source: 'inbound',
      text: 'a'.repeat(MAX_RENDERED_TEXT_BYTES),
    })

    expect(byteLength(rendered.text)).toBe(MAX_RENDERED_TEXT_BYTES)
    expect(rendered.text.endsWith(PLAIN_TEXT_TRUNCATION_MARKER)).toBe(false)
    expect(byteLength(rendered.html)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES - MAX_RENDERED_TEXT_BYTES,
    )
    expect(rendered.html.endsWith(`<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`)).toBe(true)
    expect(messageProjectionBodyBytes(rendered)).toBeLessThanOrEqual(
      MAX_MESSAGE_PROJECTION_BODY_BYTES,
    )
    expectValidGeneratedHtml(rendered.html)
  })
})

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function expectValidGeneratedHtml(html: string): void {
  const openElements: string[] = []
  const tagPattern = /<\/?([a-z][a-z0-9]*)(?:\s[^<>]*)?>/gu
  let cursor = 0

  for (const match of html.matchAll(tagPattern)) {
    const index = match.index
    expect(html.slice(cursor, index)).not.toContain('<')
    const token = match[0]
    const tag = match[1]
    expect(tag).toBeDefined()
    if (token.startsWith('</')) {
      expect(openElements.pop()).toBe(tag)
    } else if (tag !== 'br') {
      openElements.push(tag ?? '')
    }
    cursor = index + token.length
  }

  expect(html.slice(cursor)).not.toContain('<')
  expect(openElements).toEqual([])
  expect(
    html
      .replaceAll('&amp;', '')
      .replaceAll('&lt;', '')
      .replaceAll('&gt;', '')
      .replaceAll('&quot;', '')
      .replaceAll('&#39;', ''),
  ).not.toContain('&')
}
