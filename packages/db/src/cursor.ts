const CURSOR_VERSION = 1
const MAX_CURSOR_LENGTH = 512
const MAX_OPAQUE_ID_LENGTH = 128

export interface ThreadCursor {
  id: string
  lastMessageAt: number
}

export class InvalidCursorError extends Error {
  override readonly name = 'InvalidCursorError'

  constructor() {
    super('The pagination cursor is invalid.')
  }
}

/** Encodes the stable `(last_message_at, id)` descending sort position. */
export function encodeThreadCursor(cursor: ThreadCursor): string {
  assertThreadCursor(cursor)
  const payload = JSON.stringify([CURSOR_VERSION, cursor.lastMessageAt, cursor.id])
  return utf8ToBase64Url(payload)
}

/**
 * Rejects malformed cursors without reflecting their contents. Authorization
 * remains in the SQL query; cursors are navigation state, not capabilities.
 */
export function decodeThreadCursor(encoded: string): ThreadCursor {
  if (
    encoded.length === 0 ||
    encoded.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded)
  ) {
    throw new InvalidCursorError()
  }

  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(encoded))
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== CURSOR_VERSION) {
      throw new InvalidCursorError()
    }

    const cursor = { lastMessageAt: parsed[1], id: parsed[2] }
    assertThreadCursor(cursor)
    return cursor
  } catch (error) {
    if (error instanceof InvalidCursorError) {
      throw error
    }
    throw new InvalidCursorError()
  }
}

export function clampThreadPageSize(requested: number | undefined, defaultSize = 25): number {
  if (!Number.isSafeInteger(defaultSize) || defaultSize < 1 || defaultSize > 50) {
    throw new RangeError('The default page size must be between 1 and 50.')
  }
  if (requested === undefined) {
    return defaultSize
  }
  if (!Number.isFinite(requested)) {
    return defaultSize
  }
  return Math.min(50, Math.max(1, Math.trunc(requested)))
}

function assertThreadCursor(value: unknown): asserts value is ThreadCursor {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidCursorError()
  }

  const candidate = value as { id?: unknown; lastMessageAt?: unknown }
  if (
    typeof candidate.lastMessageAt !== 'number' ||
    !Number.isSafeInteger(candidate.lastMessageAt) ||
    candidate.lastMessageAt < 0 ||
    typeof candidate.id !== 'string' ||
    candidate.id.length < 1 ||
    candidate.id.length > MAX_OPAQUE_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(candidate.id)
  ) {
    throw new InvalidCursorError()
  }
}

function utf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlToUtf8(value: string): string {
  const paddingLength = (4 - (value.length % 4)) % 4
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(paddingLength)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
