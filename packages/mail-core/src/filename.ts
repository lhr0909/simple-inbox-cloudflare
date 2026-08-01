import { utf8Bytes } from './encoding'
import { removeCodePointRanges, replaceControlCharacters } from './text'

export const DEFAULT_ATTACHMENT_FILENAME = 'attachment.bin'
export const DEFAULT_MAX_FILENAME_BYTES = 180

const UNSAFE_CONTENT_TYPES = new Set([
  'application/javascript',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/html',
  'text/javascript',
])
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu

export function sanitizeFilename(
  input: string | null | undefined,
  fallback = DEFAULT_ATTACHMENT_FILENAME,
  maxBytes = DEFAULT_MAX_FILENAME_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) {
    throw new RangeError('Filename byte limit must be at least 16.')
  }

  const basename = (input ?? '').replaceAll('\\', '/').split('/').at(-1) ?? ''
  let candidate = removeCodePointRanges(replaceControlCharacters(basename.normalize('NFKC'), ''), [
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ])
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/\s+/gu, ' ')
    .replace(/^\.+/u, '')
    .replace(/[. ]+$/u, '')
    .trim()

  if (!candidate || candidate === '.' || candidate === '..') {
    candidate = cleanFallback(fallback)
  }
  if (WINDOWS_RESERVED.test(candidate)) candidate = `_${candidate}`
  candidate = truncateUtf8(candidate, maxBytes)
  return candidate || DEFAULT_ATTACHMENT_FILENAME
}

export function buildContentDisposition(
  filename: string | null | undefined,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const safe = sanitizeFilename(filename)
  const quoted = safe
    .replace(/[^\x20-\x7e]/gu, '_')
    .replaceAll('\\', '_')
    .replaceAll('"', '_')
    .replace(/_+/gu, '_')
  const encoded = encodeRfc5987(safe)
  return `${disposition}; filename="${quoted}"; filename*=UTF-8''${encoded}`
}

export function safeAttachmentContentType(input: string | null | undefined): string {
  const value = (input ?? '').trim().toLowerCase()
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(value) ||
    UNSAFE_CONTENT_TYPES.has(value)
  ) {
    return 'application/octet-stream'
  }
  return value
}

function cleanFallback(value: string): string {
  const cleaned = replaceControlCharacters(value, '')
    .replace(/[<>:"/\\|?*]/gu, '_')
    .replace(/^\.+|[. ]+$/gu, '')
    .trim()
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : DEFAULT_ATTACHMENT_FILENAME
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value).byteLength <= maxBytes) return value

  const dot = value.lastIndexOf('.')
  const extension = dot > 0 && value.length - dot <= 24 ? value.slice(dot) : ''
  const stem = extension ? value.slice(0, dot) : value
  const extensionBytes = utf8Bytes(extension).byteLength
  const available = Math.max(1, maxBytes - extensionBytes)
  let output = ''
  for (const character of stem) {
    if (utf8Bytes(output + character).byteLength > available) break
    output += character
  }
  return `${output.replace(/[. ]+$/u, '')}${extension}`
}

function encodeRfc5987(value: string): string {
  let output = ''
  for (const byte of utf8Bytes(value)) {
    const character = String.fromCharCode(byte)
    output += /^[A-Za-z0-9!#$&+\-.^_`|~]$/u.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return output
}
