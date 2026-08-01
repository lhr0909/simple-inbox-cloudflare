const encoder = new TextEncoder()

export const API_TOKEN_SCOPE = {
  read: 1,
  send: 2,
  settings: 4,
} as const

export type ApiTokenScope = keyof typeof API_TOKEN_SCOPE

export interface GeneratedOpaqueToken {
  /** The only value that may be shown to the caller. Never persist or log it. */
  plaintext: string
}

export type TokenPepper = CryptoKey | Uint8Array | string

/**
 * Generates a URL-safe bearer credential with at least 256 bits of entropy.
 * The caller must persist only `digestOpaqueToken(plaintext, pepper)`.
 */
export function generateOpaqueToken(byteLength = 32): GeneratedOpaqueToken {
  if (!Number.isSafeInteger(byteLength) || byteLength < 32 || byteLength > 128) {
    throw new RangeError('Opaque tokens must contain between 32 and 128 random bytes.')
  }

  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return { plaintext: bytesToBase64Url(bytes) }
}

/**
 * HMAC is used instead of a plain hash so a stolen database is insufficient
 * to test candidate bearer tokens without the separately managed Worker secret.
 */
export async function digestOpaqueToken(token: string, pepper: TokenPepper): Promise<string> {
  if (token.length < 32 || token.length > 512) {
    throw new RangeError('Opaque token length is outside the accepted range.')
  }

  const key = await importPepper(pepper)
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(token))
  return bytesToHex(new Uint8Array(digest))
}

/** Produces a non-secret SHA-256 digest for request/idempotency comparisons. */
export async function digestRequest(bytes: BufferSource | string): Promise<string> {
  const input = typeof bytes === 'string' ? encoder.encode(bytes) : bytes
  const digest = await crypto.subtle.digest('SHA-256', input)
  return bytesToHex(new Uint8Array(digest))
}

export function encodeApiTokenScopes(scopes: readonly ApiTokenScope[]): number {
  let encoded = 0
  for (const scope of scopes) {
    encoded |= API_TOKEN_SCOPE[scope]
  }

  if (encoded === 0) {
    throw new RangeError('At least one API token scope is required.')
  }

  return encoded
}

export function decodeApiTokenScopes(encoded: number): ApiTokenScope[] {
  assertScopeBits(encoded)
  return (Object.keys(API_TOKEN_SCOPE) as ApiTokenScope[]).filter(
    (scope) => (encoded & API_TOKEN_SCOPE[scope]) !== 0,
  )
}

export function hasApiTokenScopes(
  encoded: number,
  required: ApiTokenScope | readonly ApiTokenScope[],
): boolean {
  assertScopeBits(encoded)
  const requiredBits = encodeApiTokenScopes(typeof required === 'string' ? [required] : required)
  return (encoded & requiredBits) === requiredBits
}

/** Constant-time comparison for already-computed, same-length digest strings. */
export function timingSafeDigestEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false
  }

  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

async function importPepper(pepper: TokenPepper): Promise<CryptoKey> {
  if (typeof pepper !== 'string' && !(pepper instanceof Uint8Array)) {
    return pepper
  }

  const material = typeof pepper === 'string' ? encoder.encode(pepper) : new Uint8Array(pepper)
  if (material.byteLength < 32) {
    throw new RangeError('AUTH_TOKEN_PEPPER must contain at least 32 bytes.')
  }

  return crypto.subtle.importKey('raw', material, { hash: 'SHA-256', name: 'HMAC' }, false, [
    'sign',
  ])
}

function assertScopeBits(encoded: number): void {
  if (!Number.isSafeInteger(encoded) || encoded < 1 || encoded > 7) {
    throw new RangeError('API token scope bits must be an integer from 1 through 7.')
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function bytesToHex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0')
  }
  return output
}
