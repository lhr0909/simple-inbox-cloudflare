import {
  MAX_PROVIDER_ATTACHMENTS,
  MAX_RENDERED_TEXT_CHARACTERS,
  cleanHeaderText,
  normalizeEmailAddress,
  normalizeInReplyTo,
  normalizeMessageId,
  normalizeReferences,
  normalizeSubject,
  renderSafeMessageContent,
  safeAttachmentContentType,
  sanitizeFilename,
} from '@cloudflare-inbox/mail-core'
import PostalMime, { type Address, type Attachment, type Mailbox } from 'postal-mime'

import type { NormalizedAttachment, NormalizedInboundMessage, NormalizedRecipient } from '../types'

const MAX_PARSE_HEADERS_BYTES = 256 * 1_024
const MAX_PARSE_NESTING_DEPTH = 20
const MAX_PROJECTED_ATTACHMENTS = MAX_PROVIDER_ATTACHMENTS
const MAX_PROJECTED_CONTENT_ID = 500
const MAX_PROJECTED_MEDIA_TYPE = 255
const MAX_PROJECTED_RECIPIENTS = 200
const MAX_PROJECTED_REFERENCES = 100
const MAX_PROJECTED_REFERENCE_BYTES = MAX_PROJECTED_REFERENCES * 1_000
const MAX_PROJECTED_SUBJECT = 998

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'html',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
])

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  copy: '©',
  emsp: '\u2003',
  ensp: '\u2002',
  gt: '>',
  hellip: '…',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  reg: '®',
  thinsp: '\u2009',
}

export async function parseInboundMime(
  raw: Uint8Array,
  receivedAt: number,
): Promise<NormalizedInboundMessage> {
  const parsed = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer',
    maxHeadersSize: MAX_PARSE_HEADERS_BYTES,
    maxNestingDepth: MAX_PARSE_NESTING_DEPTH,
  })
  const from = flattenAddresses(parsed.from === undefined ? [] : [parsed.from])[0]
  if (from === undefined) throw new TypeError('The message does not contain a valid From address.')

  const recipients = normalizeRecipientFields(parsed)
  let rendered = renderSafeMessageContent({
    source: 'inbound',
    text: parsed.text ?? '',
  })
  if (!rendered.text && parsed.html) {
    rendered = renderSafeMessageContent({
      source: 'inbound',
      text: htmlToPlainText(parsed.html, MAX_RENDERED_TEXT_CHARACTERS + 1),
    })
  }
  const sentAt = parseMessageDate(parsed.date, receivedAt)
  return {
    attachments: parsed.attachments.slice(0, MAX_PROJECTED_ATTACHMENTS).map(normalizeAttachment),
    bcc: recipients.bcc,
    cc: recipients.cc,
    from,
    html: rendered.html,
    ...(parsed.html ? { originalHtml: parsed.html } : {}),
    inReplyTo: normalizeInReplyTo(parsed.inReplyTo),
    internetMessageId: normalizeMessageId(parsed.messageId),
    references: normalizeReferences(parsed.references, {
      maxBytes: MAX_PROJECTED_REFERENCE_BYTES,
      maxCount: MAX_PROJECTED_REFERENCES,
    }),
    replyTo: recipients.replyTo,
    sentAt,
    subject: boundedString(normalizeSubject(parsed.subject), MAX_PROJECTED_SUBJECT),
    text: rendered.text,
    to: recipients.to,
  }
}

function normalizeRecipientFields(parsed: {
  bcc?: readonly Address[]
  cc?: readonly Address[]
  replyTo?: readonly Address[]
  to?: readonly Address[]
}): Pick<NormalizedInboundMessage, 'bcc' | 'cc' | 'replyTo' | 'to'> {
  let remaining = MAX_PROJECTED_RECIPIENTS
  const take = (input: readonly Address[]): NormalizedRecipient[] => {
    const recipients = flattenAddresses(input, remaining)
    remaining -= recipients.length
    return recipients
  }

  // Keep field priority and mailbox order deterministic. Deduplication remains
  // field-scoped because the same address can legitimately have two MIME roles.
  const to = take(parsed.to ?? [])
  const cc = take(parsed.cc ?? [])
  const replyTo = take(parsed.replyTo ?? [])
  const bcc = take(parsed.bcc ?? [])
  return { bcc, cc, replyTo, to }
}

function flattenAddresses(
  input: readonly Address[],
  maximum = Number.POSITIVE_INFINITY,
): NormalizedRecipient[] {
  if (maximum <= 0) return []
  const output: NormalizedRecipient[] = []
  const seen = new Set<string>()
  addressEntries: for (const entry of input) {
    const mailboxes: readonly Mailbox[] = entry.group ?? ('address' in entry ? [entry] : [])
    for (const mailbox of mailboxes) {
      let address: string
      try {
        address = normalizeEmailAddress(mailbox.address)
      } catch {
        continue
      }
      if (seen.has(address)) continue
      seen.add(address)
      const displayName = boundedString(cleanHeaderText(mailbox.name), 256) || null
      output.push({ address, displayName })
      if (output.length >= maximum) break addressEntries
    }
  }
  return output
}

function normalizeAttachment(attachment: Attachment): NormalizedAttachment {
  return {
    bytes: attachmentBytes(attachment.content),
    contentId: boundedHeaderValue(attachment.contentId),
    disposition:
      attachment.disposition === 'attachment' || attachment.disposition === 'inline'
        ? attachment.disposition
        : 'unknown',
    filename: sanitizeFilename(attachment.filename),
    mediaType: normalizedAttachmentMediaType(attachment.mimeType),
  }
}

function attachmentBytes(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  if (content instanceof Uint8Array) return new Uint8Array(content)
  return new Uint8Array(content)
}

function boundedHeaderValue(input: string | undefined): string | null {
  const value = boundedString(cleanHeaderText(input), MAX_PROJECTED_CONTENT_ID)
  return value || null
}

function normalizedAttachmentMediaType(input: string | undefined): string {
  const mediaType = safeAttachmentContentType(input)
  return mediaType.length <= MAX_PROJECTED_MEDIA_TYPE ? mediaType : 'application/octet-stream'
}

function boundedString(input: string, maximum: number): string {
  if (input.length <= maximum) return input
  let end = maximum
  const finalCodeUnit = input.charCodeAt(end - 1)
  const nextCodeUnit = input.charCodeAt(end)
  if (
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  ) {
    end -= 1
  }
  return input.slice(0, end)
}

/**
 * Extracts only visible text. Tags and their attributes are never copied, so
 * remote image/link URLs and event handlers cannot become projected content.
 * Script/style bodies and comments are skipped even when their text looks safe.
 */
function htmlToPlainText(input: string, maximum: number): string {
  const output: string[] = []
  let length = 0
  let index = 0
  let skippedElement: 'script' | 'style' | null = null

  const append = (value: string): boolean => {
    const bounded = boundedString(value, maximum - length)
    if (bounded) {
      output.push(bounded)
      length += bounded.length
    }
    return length < maximum
  }

  while (index < input.length && length < maximum) {
    if (input.startsWith('<!--', index)) {
      const commentEnd = input.indexOf('-->', index + 4)
      if (commentEnd === -1) break
      index = commentEnd + 3
      continue
    }

    if (input[index] === '<') {
      const tagEnd = findTagEnd(input, index + 1)
      if (tagEnd === -1) break
      const tag = parseTag(input.slice(index + 1, tagEnd))
      index = tagEnd + 1
      if (tag === null) continue

      if (skippedElement !== null) {
        if (tag.closing && tag.name === skippedElement) skippedElement = null
        continue
      }
      if (!tag.closing && (tag.name === 'script' || tag.name === 'style')) {
        skippedElement = tag.name
        continue
      }
      if (BLOCK_TAGS.has(tag.name) && !append('\n')) break
      continue
    }

    if (skippedElement !== null) {
      const nextTag = input.indexOf('<', index)
      if (nextTag === -1) break
      index = nextTag
      continue
    }

    if (input[index] === '&') {
      const entityEnd = input.indexOf(';', index + 1)
      if (entityEnd !== -1 && entityEnd - index <= 32) {
        const decoded = decodeHtmlEntity(input.slice(index + 1, entityEnd))
        if (decoded !== null) {
          if (!append(decoded)) break
          index = entityEnd + 1
          continue
        }
      }
    }

    const codePoint = input.codePointAt(index)
    if (codePoint === undefined) break
    const character = String.fromCodePoint(codePoint)
    if (!append(character)) break
    index += character.length
  }

  return output.join('')
}

function findTagEnd(input: string, start: number): number {
  let quote: '"' | "'" | null = null
  for (let index = start; index < input.length; index += 1) {
    const character = input[index]
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '>') return index
  }
  return -1
}

function parseTag(source: string): { closing: boolean; name: string } | null {
  const match = source.match(/^\s*(\/)?\s*([a-z][a-z0-9:-]*)/iu)
  const name = match?.[2]?.toLocaleLowerCase('en-US')
  if (!name) return null
  return {
    closing: match?.[1] !== undefined,
    name,
  }
}

function decodeHtmlEntity(source: string): string | null {
  if (!source.startsWith('#')) return HTML_ENTITIES[source.toLocaleLowerCase('en-US')] ?? null

  const hexadecimal = source[1]?.toLocaleLowerCase('en-US') === 'x'
  const digits = source.slice(hexadecimal ? 2 : 1)
  if (!(hexadecimal ? /^[0-9a-f]+$/iu : /^\d+$/u).test(digits)) return null
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
  if (
    !Number.isSafeInteger(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return ''
  }
  return String.fromCodePoint(codePoint)
}

function parseMessageDate(value: string | undefined, fallback: number): number {
  const timestamp = value === undefined ? Number.NaN : Date.parse(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : fallback
}
