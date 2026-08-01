import {
  formatAddress,
  parseAddressList,
  type AddressFieldInput,
  type MailAddress,
} from './address'
import { bytesToBase64, normalizeCrlf, toBytes, utf8Bytes, wrapBase64 } from './encoding'
import { buildContentDisposition, safeAttachmentContentType, sanitizeFilename } from './filename'
import {
  cleanHeaderText,
  normalizeInReplyTo,
  normalizeMessageId,
  normalizeReferences,
  normalizeSubject,
} from './headers'
import type { RenderedMessageContent } from './render'

export interface CanonicalAttachment {
  filename: string
  contentType?: string | null
  content: string | Uint8Array | ArrayBuffer
  disposition?: 'attachment' | 'inline'
  contentId?: string | null
}

export interface CanonicalOutboundEmlInput {
  providerMessageId: string
  sentAt: string | number | Date
  from: string
  to: AddressFieldInput
  cc?: AddressFieldInput
  subject: string
  content: RenderedMessageContent
  inReplyTo?: string | readonly string[] | null
  references?: string | readonly string[] | null
  attachments?: readonly CanonicalAttachment[]
}

export function generateCanonicalOutboundEml(input: CanonicalOutboundEmlInput): Uint8Array {
  const providerId = cleanHeaderText(input.providerMessageId)
  if (!providerId) throw new TypeError('Canonical EML requires a provider message ID.')
  const sentAt = toValidDate(input.sentAt)
  const from = parseAddressList(input.from)
  if (from.length !== 1) throw new TypeError('Canonical EML requires exactly one From address.')
  const to = parseAddressList(input.to)
  if (to.length === 0) throw new TypeError('Canonical EML requires at least one To address.')
  const cc = parseAddressList(input.cc)
  const attachments = input.attachments ?? []
  const providerInternetMessageId = normalizeMessageId(providerId)
  const messageId =
    providerInternetMessageId ?? `<${shortStableToken(providerId)}@canonical.invalid>`
  const inReplyTo = normalizeInReplyTo(input.inReplyTo)
  const references = normalizeReferences(input.references)
  const rootBoundary = `=_mail_core_${shortStableToken(`${providerId}:mixed`)}`
  const alternativeBoundary = `=_mail_core_${shortStableToken(`${providerId}:alternative`)}`

  const headers = [
    `Date: ${sentAt.toUTCString()}`,
    foldAddressHeader('From', from),
    foldAddressHeader('To', to),
    cc.length ? foldAddressHeader('Cc', cc) : null,
    foldHeaderValue('Subject', encodeHeaderValue(normalizeSubject(input.subject))),
    `Message-ID: ${messageId}`,
    providerInternetMessageId
      ? null
      : foldHeaderValue('X-Provider-Message-ID', encodeHeaderValue(providerId)),
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references.length ? foldSpaceSeparatedHeader('References', references) : null,
    'MIME-Version: 1.0',
  ].filter((header): header is string => header !== null)

  let mimeBody: string
  if (attachments.length > 0) {
    headers.push(`Content-Type: multipart/mixed; boundary="${rootBoundary}"`)
    const parts = [
      renderContentPart(input.content, alternativeBoundary),
      ...attachments.map(renderAttachmentPart),
    ]
    mimeBody = renderMultipart(rootBoundary, parts)
  } else if (input.content.html) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`)
    mimeBody = renderMultipart(alternativeBoundary, [
      renderTextPart('text/plain', input.content.text),
      renderTextPart('text/html', input.content.html),
    ])
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    headers.push('Content-Transfer-Encoding: base64')
    mimeBody = encodeMimeBody(input.content.text)
  }

  return utf8Bytes(`${headers.join('\r\n')}\r\n\r\n${mimeBody}\r\n`)
}

export function canonicalEmlToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function renderContentPart(content: RenderedMessageContent, boundary: string): string {
  if (!content.html) return renderTextPart('text/plain', content.text)
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    renderMultipart(boundary, [
      renderTextPart('text/plain', content.text),
      renderTextPart('text/html', content.html),
    ]),
  ].join('\r\n')
}

function renderTextPart(contentType: 'text/plain' | 'text/html', content: string): string {
  return [
    `Content-Type: ${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    encodeMimeBody(content),
  ].join('\r\n')
}

function renderAttachmentPart(attachment: CanonicalAttachment): string {
  const filename = sanitizeFilename(attachment.filename)
  const disposition = attachment.disposition ?? 'attachment'
  const contentId = normalizeMessageId(attachment.contentId)
  return [
    `Content-Type: ${safeAttachmentContentType(attachment.contentType)}; name="${asciiFilename(filename)}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${buildContentDisposition(filename, disposition)}`,
    disposition === 'inline' && contentId ? `Content-ID: ${contentId}` : null,
    '',
    wrapBase64(bytesToBase64(toBytes(attachment.content))),
  ]
    .filter((line): line is string => line !== null)
    .join('\r\n')
}

function renderMultipart(boundary: string, parts: readonly string[]): string {
  return [...parts.flatMap((part) => [`--${boundary}`, part]), `--${boundary}--`].join('\r\n')
}

function encodeMimeBody(value: string): string {
  return wrapBase64(bytesToBase64(utf8Bytes(normalizeCrlf(value))))
}

function foldAddressHeader(name: string, addresses: readonly MailAddress[]): string {
  const rendered = addresses.map(renderHeaderAddress)
  return foldHeaderValue(name, rendered.join(', '))
}

function renderHeaderAddress(address: MailAddress): string {
  if (!address.name || /^[\x20-\x7e]+$/u.test(address.name)) return formatAddress(address)
  return `${encodeHeaderValue(address.name)} <${address.address}>`
}

function foldHeaderValue(name: string, value: string): string {
  const tokens = value.split(' ')
  let output = `${name}:`
  let currentLength = output.length
  for (const token of tokens) {
    if (currentLength > name.length + 1 && currentLength + token.length + 1 > 78) {
      output += `\r\n ${token}`
      currentLength = token.length + 1
    } else {
      output += ` ${token}`
      currentLength += token.length + 1
    }
  }
  return output
}

function foldSpaceSeparatedHeader(name: string, values: readonly string[]): string {
  let output = `${name}:`
  let length = output.length
  for (const value of values) {
    if (length + value.length + 1 > 78) {
      output += `\r\n ${value}`
      length = value.length + 1
    } else {
      output += ` ${value}`
      length += value.length + 1
    }
  }
  return output
}

function encodeHeaderValue(value: string): string {
  const cleaned = cleanHeaderText(value)
  if (/^[\x20-\x7e]*$/u.test(cleaned) && cleaned.length <= 60) return cleaned

  const words: string[] = []
  let chunk = ''
  for (const character of cleaned) {
    if (utf8Bytes(chunk + character).byteLength > 30 && chunk) {
      words.push(`=?UTF-8?B?${bytesToBase64(utf8Bytes(chunk))}?=`)
      chunk = character
    } else {
      chunk += character
    }
  }
  if (chunk) words.push(`=?UTF-8?B?${bytesToBase64(utf8Bytes(chunk))}?=`)
  return words.join(' ')
}

function asciiFilename(value: string): string {
  return value.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
}

function shortStableToken(value: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (const byte of utf8Bytes(value)) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0
    second = Math.imul(second ^ byte, 0x85ebca6b) >>> 0
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

function toValidDate(value: string | number | Date): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError('Canonical EML date is invalid.')
  return date
}
