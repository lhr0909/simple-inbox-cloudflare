import { containsControlCharacters, replaceControlCharacters } from './text'

export type MessageContentSource = 'inbound' | 'app'

export interface MessageContentInput {
  source: MessageContentSource
  text?: string | null
  markdown?: string | null
  html?: string | null
}

export interface RenderedMessageContent {
  text: string
  html: string
}

export const MAX_RENDERED_TEXT_CHARACTERS = 1_000_000
export const MAX_RENDERED_HTML_CHARACTERS = 2_000_000
/**
 * Cloudflare D1 limits one row and each TEXT value to 2,000,000 bytes. Message
 * bodies share a row with identifiers, headers, state, digests, and timestamps,
 * so normalized text and HTML projections deliberately use only 75% of that
 * limit. The remaining 500,000 bytes are reserved for meaningful row overhead.
 */
export const MAX_MESSAGE_PROJECTION_BODY_BYTES = 1_500_000
export const MAX_RENDERED_TEXT_BYTES = 1_000_000
export const MAX_RENDERED_HTML_BYTES = 1_250_000
export const PLAIN_TEXT_TRUNCATION_MARKER = '[Message truncated]'

const HTML_TRUNCATION_MARKER = `<p>${PLAIN_TEXT_TRUNCATION_MARKER}</p>`
const GENERATED_HTML_ENTITIES = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'] as const
const UTF8_ENCODER = new TextEncoder()

export function renderSafeMessageContent(input: MessageContentInput): RenderedMessageContent {
  if (input.source === 'app' && input.markdown !== null && input.markdown !== undefined) {
    const normalizedMarkdown = normalizeBodyText(input.markdown)
    const markdownWasTruncated = exceedsTextProjectionLimit(normalizedMarkdown)
    const boundedMarkdown = markdownWasTruncated
      ? boundedUtf8Prefix(normalizedMarkdown, MAX_RENDERED_TEXT_CHARACTERS, MAX_RENDERED_TEXT_BYTES)
      : normalizedMarkdown
    const text = boundPlainText(markdownToPlainText(boundedMarkdown), markdownWasTruncated)

    return boundedMessageContent(
      text,
      renderMarkdownToSafeHtml(boundedMarkdown),
      markdownWasTruncated,
    )
  }

  // Inbound HTML is intentionally ignored. Only normalized plain text enters the
  // renderer, so script, style, remote images, event handlers, and cid URLs cannot
  // survive even when a parser supplies an `html` field.
  const text = boundPlainText(normalizeBodyText(input.text ?? ''))
  return boundedMessageContent(text, renderPlainTextToSafeHtml(text))
}

export function messageProjectionBodyBytes(content: RenderedMessageContent): number {
  return utf8ByteLength(content.text) + utf8ByteLength(content.html)
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderPlainTextToSafeHtml(input: string): string {
  const text = normalizeBodyText(input)
  if (!text) return '<p></p>'
  return text
    .split(/\n{2,}/u)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll('\n', '<br>\n')}</p>`)
    .join('\n')
}

export function renderMarkdownToSafeHtml(input: string): string {
  const source = normalizeBodyText(input).replace(/[\ue000-\uf8ff]/gu, '')
  if (!source) return '<p></p>'
  const lines = source.split('\n')
  const output: string[] = []

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^\s*```(?:[\w.+-]+)?\s*$/u)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/u)
    if (heading) {
      const level = heading[1]?.length ?? 1
      output.push(`<h${level}>${renderInlineMarkdown(heading[2] ?? '')}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*>\s?/u.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^\s*>\s?/u.test(lines[index] ?? '')) {
        quoted.push((lines[index] ?? '').replace(/^\s*>\s?/u, ''))
        index += 1
      }
      output.push(
        `<blockquote>${renderInlineMarkdown(quoted.join('\n')).replaceAll('\n', '<br>\n')}</blockquote>`,
      )
      continue
    }

    const listMatch = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u)
    if (listMatch) {
      const ordered = Boolean(listMatch[2])
      const items: string[] = []
      const itemPattern = ordered ? /^\s*\d+\.\s+(.+)$/u : /^\s*[-+*]\s+(.+)$/u
      while (index < lines.length) {
        const item = (lines[index] ?? '').match(itemPattern)
        if (!item) break
        items.push(`<li>${renderInlineMarkdown(item[1] ?? '')}</li>`)
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      output.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }

    const paragraph: string[] = [line]
    index += 1
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !isBlockStart(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '')
      index += 1
    }
    output.push(`<p>${renderInlineMarkdown(paragraph.join('\n')).replaceAll('\n', '<br>\n')}</p>`)
  }
  return output.join('\n')
}

export function markdownToPlainText(input: string): string {
  return normalizeBodyText(input)
    .replace(/^[ \t]*```[^\n]*$/gmu, '')
    .replace(/^[ \t]*```[ \t]*$/gmu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/gu, '$1 ($2)')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '')
    .replace(/^[ \t]*>[ \t]?/gmu, '')
    .replace(/^[ \t]*(?:[-+*]|\d+\.)[ \t]+/gmu, '')
    .replace(/(`{1,2}|\*{1,2}|_{1,2}|~~)/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function renderInlineMarkdown(input: string): string {
  const replacements: string[] = []
  const placeholder = (html: string): string => {
    const index = replacements.push(html) - 1
    return `\ue000${index}\ue001`
  }

  let value = input.replace(/`([^`\n]+)`/gu, (_match, code: string) =>
    placeholder(`<code>${escapeHtml(code)}</code>`),
  )
  value = value.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/gu,
    (_match, label: string, destination: string) => {
      const safeDestination = safeLinkDestination(destination)
      if (!safeDestination) return label
      return placeholder(
        `<a href="${escapeHtml(safeDestination)}" rel="nofollow noopener noreferrer">${escapeHtml(label)}</a>`,
      )
    },
  )

  value = escapeHtml(value)
    .replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/gu, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/gu, '<em>$1</em>')
    .replace(/_([^_\n]+)_/gu, '<em>$1</em>')

  return value.replace(/\ue000(\d+)\ue001/gu, (_match, rawIndex: string) => {
    const replacement = replacements[Number(rawIndex)]
    return replacement ?? ''
  })
}

function safeLinkDestination(input: string): string | null {
  const value = input.trim()
  if (containsControlCharacters(value, true) || /["'<>]/u.test(value)) return null
  return /^(?:https?:\/\/|mailto:)/iu.test(value) ? value : null
}

function normalizeBodyText(value: string): string {
  const newlines = value.replace(/\r\n|\r/gu, '\n')
  return replaceControlCharacters(newlines, '', [0x09, 0x0a]).trim()
}

function isBlockStart(line: string): boolean {
  return (
    /^\s*```/u.test(line) ||
    /^\s{0,3}#{1,6}\s+/u.test(line) ||
    /^\s*>\s?/u.test(line) ||
    /^\s*(?:[-+*]|\d+\.)\s+/u.test(line)
  )
}

function boundPlainText(value: string, forceMarker = false): string {
  if (!forceMarker && !exceedsTextProjectionLimit(value)) return value

  const markerWithSeparator = `\n\n${PLAIN_TEXT_TRUNCATION_MARKER}`
  const availableCharacters = MAX_RENDERED_TEXT_CHARACTERS - markerWithSeparator.length
  const availableBytes = MAX_RENDERED_TEXT_BYTES - utf8ByteLength(markerWithSeparator)
  const prefix = boundedUtf8Prefix(value, availableCharacters, availableBytes).trimEnd()
  return prefix ? `${prefix}${markerWithSeparator}` : PLAIN_TEXT_TRUNCATION_MARKER
}

function boundedMessageContent(
  text: string,
  unboundedHtml: string,
  forceHtmlMarker = false,
): RenderedMessageContent {
  const remainingBodyBytes = MAX_MESSAGE_PROJECTION_BODY_BYTES - utf8ByteLength(text)
  const html = boundSafeHtml(
    unboundedHtml,
    forceHtmlMarker,
    Math.min(MAX_RENDERED_HTML_BYTES, remainingBodyBytes),
  )
  const content = { html, text }
  if (messageProjectionBodyBytes(content) > MAX_MESSAGE_PROJECTION_BODY_BYTES) {
    throw new Error('Rendered message content exceeded its D1 projection budget.')
  }
  return content
}

/**
 * Bounds HTML emitted by this module without ever slicing a tag, entity, or Unicode code point.
 * Open generated elements are closed before a separate truncation paragraph is appended.
 */
function boundSafeHtml(
  value: string,
  forceMarker = false,
  maximumBytes = MAX_RENDERED_HTML_BYTES,
): string {
  const structurallyValidValue = normalizeGeneratedHtmlStructure(value)
  if (
    !forceMarker &&
    structurallyValidValue.length <= MAX_RENDERED_HTML_CHARACTERS &&
    utf8ByteLength(structurallyValidValue) <= maximumBytes
  ) {
    return structurallyValidValue
  }

  const completeSuffix = (hasPrefix: boolean): string =>
    `${hasPrefix ? '\n' : ''}${HTML_TRUNCATION_MARKER}`
  const completeSuffixBytes = (hasPrefix: boolean): number =>
    utf8ByteLength(HTML_TRUNCATION_MARKER) + (hasPrefix ? 1 : 0)

  if (
    forceMarker &&
    structurallyValidValue.length + completeSuffix(structurallyValidValue.length > 0).length <=
      MAX_RENDERED_HTML_CHARACTERS &&
    utf8ByteLength(structurallyValidValue) +
      completeSuffixBytes(structurallyValidValue.length > 0) <=
      maximumBytes
  ) {
    return `${structurallyValidValue}${completeSuffix(structurallyValidValue.length > 0)}`
  }

  const output: string[] = []
  let outputBytes = 0
  let index = 0
  const openElements: string[] = []
  let closingBytes = 0

  const closingMarkup = (): string =>
    openElements
      .toReversed()
      .map((tag) => `</${tag}>`)
      .join('')

  const fitsWithRequiredSuffix = (token: string, nextClosingBytes: number): boolean => {
    const tokenBytes = utf8ByteLength(token)
    return (
      outputBytes +
        tokenBytes +
        nextClosingBytes +
        completeSuffixBytes(outputBytes + tokenBytes > 0) <=
      maximumBytes
    )
  }

  while (index < structurallyValidValue.length) {
    if (structurallyValidValue[index] === '<') {
      const end = structurallyValidValue.indexOf('>', index)
      if (end === -1) break
      const token = structurallyValidValue.slice(index, end + 1)
      const closing = token.match(/^<\/([a-z][a-z0-9]*)>$/u)

      if (closing) {
        output.push(token)
        outputBytes += utf8ByteLength(token)
        const tag = openElements.pop()
        if (tag) closingBytes -= utf8ByteLength(`</${tag}>`)
        index = end + 1
        continue
      }

      const opening = token.match(/^<([a-z][a-z0-9]*)(?:\s[^<>]*)?>$/u)
      const tag = opening?.[1]
      const addedClosingBytes = tag && tag !== 'br' ? utf8ByteLength(`</${tag}>`) : 0
      if (!fitsWithRequiredSuffix(token, closingBytes + addedClosingBytes)) break

      output.push(token)
      outputBytes += utf8ByteLength(token)
      if (tag && tag !== 'br') {
        openElements.push(tag)
        closingBytes += addedClosingBytes
      }
      index = end + 1
      continue
    }

    if (structurallyValidValue[index] === '&') {
      const entity = GENERATED_HTML_ENTITIES.find((candidate) =>
        structurallyValidValue.startsWith(candidate, index),
      )
      if (entity) {
        if (!fitsWithRequiredSuffix(entity, closingBytes)) break
        output.push(entity)
        outputBytes += utf8ByteLength(entity)
        index += entity.length
        continue
      }
    }

    const nextTag = structurallyValidValue.indexOf('<', index + 1)
    const nextEntity = structurallyValidValue.indexOf('&', index + 1)
    const nextSpecialCharacter =
      nextTag === -1 ? nextEntity : nextEntity === -1 ? nextTag : Math.min(nextTag, nextEntity)
    const runEnd =
      nextSpecialCharacter === -1 ? structurallyValidValue.length : nextSpecialCharacter
    const availableBytes = maximumBytes - outputBytes - closingBytes - completeSuffixBytes(true)
    if (availableBytes <= 0) break
    const run = structurallyValidValue.slice(index, runEnd)
    const token = boundedUtf8Prefix(run, MAX_RENDERED_HTML_CHARACTERS, availableBytes)
    if (!token) break
    output.push(token)
    outputBytes += utf8ByteLength(token)
    index += token.length
    if (index < runEnd) break
  }

  const closing = closingMarkup()
  const hasPrefix = outputBytes > 0
  output.push(closing, completeSuffix(hasPrefix))
  return output.join('')
}

function normalizeGeneratedHtmlStructure(value: string): string {
  const output: string[] = []
  const openElements: string[] = []
  const tagPattern = /<\/?([a-z][a-z0-9]*)(?:\s[^<>]*)?>/gu
  let cursor = 0

  for (const match of value.matchAll(tagPattern)) {
    const index = match.index
    output.push(value.slice(cursor, index))
    const token = match[0]
    const tag = match[1]
    if (!tag) continue

    if (token.startsWith('</')) {
      const matchingIndex = openElements.lastIndexOf(tag)
      if (matchingIndex !== -1) {
        while (openElements.length - 1 > matchingIndex) {
          output.push(`</${openElements.pop() ?? ''}>`)
        }
        openElements.pop()
        output.push(token)
      }
    } else {
      output.push(token)
      if (tag !== 'br') openElements.push(tag)
    }
    cursor = index + token.length
  }

  output.push(value.slice(cursor))
  while (openElements.length > 0) output.push(`</${openElements.pop() ?? ''}>`)
  return output.join('')
}

function exceedsTextProjectionLimit(value: string): boolean {
  return (
    value.length > MAX_RENDERED_TEXT_CHARACTERS || utf8ByteLength(value) > MAX_RENDERED_TEXT_BYTES
  )
}

function boundedUtf8Prefix(value: string, maximumCharacters: number, maximumBytes: number): string {
  const characterBounded = prefixWithoutSplittingCodePoint(value, maximumCharacters)
  if (utf8ByteLength(characterBounded) <= maximumBytes) return characterBounded
  const target = new Uint8Array(Math.max(0, maximumBytes))
  const { read } = UTF8_ENCODER.encodeInto(characterBounded, target)
  return characterBounded.slice(0, read)
}

function prefixWithoutSplittingCodePoint(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) return value
  let end = maximumLength
  const finalCodeUnit = value.charCodeAt(end - 1)
  const nextCodeUnit = value.charCodeAt(end)
  if (
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1
  }
  return value.slice(0, end)
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength
}
