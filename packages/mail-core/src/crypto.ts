import { normalizeEmailAddress, normalizeEnvelopeAddress } from './address'
import { bytesToBase64Url, bytesToHex, toBytes, utf8Bytes } from './encoding'
import { MailCoreError } from './errors'

export interface WebCryptoLike {
  subtle: {
    digest(algorithm: string, data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer>
  }
  getRandomValues?<T extends ArrayBufferView>(array: T): T
}

export type DigestInput = string | Uint8Array | ArrayBuffer

export async function sha256Bytes(
  input: DigestInput,
  cryptoProvider: WebCryptoLike = resolveCrypto(),
): Promise<Uint8Array> {
  const data = toBytes(input)
  const digest = await cryptoProvider.subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

export async function sha256Hex(
  input: DigestInput,
  cryptoProvider?: WebCryptoLike,
): Promise<string> {
  return bytesToHex(await sha256Bytes(input, cryptoProvider))
}

export async function computeInboundIngestDigest(
  input: {
    rawSha256: string
    envelopeFrom: string | null
    envelopeTo: string
  },
  cryptoProvider?: WebCryptoLike,
): Promise<string> {
  const rawSha256 = input.rawSha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(rawSha256)) {
    throw new MailCoreError(
      'invalid_idempotency_input',
      'Inbound digest requires the exact raw SHA-256 value.',
    )
  }
  return sha256Hex(
    stableSerialize({
      envelopeFrom: normalizeEnvelopeAddress(input.envelopeFrom, { allowNullReversePath: true }),
      envelopeTo: normalizeEmailAddress(input.envelopeTo),
      rawSha256,
      version: 1,
    }),
    cryptoProvider,
  )
}

export async function computeIdempotencyRequestDigest(
  request: unknown,
  cryptoProvider?: WebCryptoLike,
): Promise<string> {
  return sha256Hex(stableSerialize(request), cryptoProvider)
}

export function createIdempotencyKey(
  cryptoProvider: WebCryptoLike = resolveCrypto(),
  byteLength = 24,
): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 64) {
    throw new MailCoreError(
      'invalid_idempotency_input',
      'Idempotency keys must contain 16 to 64 random bytes.',
    )
  }
  if (!cryptoProvider.getRandomValues) {
    throw new MailCoreError('missing_crypto', 'Web Crypto getRandomValues is unavailable.')
  }
  const bytes = new Uint8Array(byteLength)
  cryptoProvider.getRandomValues(bytes)
  return bytesToBase64Url(bytes)
}

export type PersistedSendState = 'pending' | 'complete' | 'unknown'
export type IdempotencyDecision =
  | { action: 'start' }
  | { action: 'replay' }
  | { action: 'conflict' }
  | { action: 'in_progress' }
  | { action: 'unknown' }

export function decideIdempotentSend(
  existing: { requestDigest: string; state: PersistedSendState } | null,
  requestDigest: string,
): IdempotencyDecision {
  if (!/^[a-f0-9]{64}$/u.test(requestDigest)) {
    throw new MailCoreError(
      'invalid_idempotency_input',
      'Request digest must be a hexadecimal SHA-256 digest.',
    )
  }
  if (!existing) return { action: 'start' }
  if (existing.requestDigest !== requestDigest) return { action: 'conflict' }
  if (existing.state === 'complete') return { action: 'replay' }
  if (existing.state === 'unknown') return { action: 'unknown' }
  return { action: 'in_progress' }
}

export function stableSerialize(value: unknown): string {
  const active = new Set<object>()

  const encode = (item: unknown): string => {
    if (item === null) return 'null'
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) {
        throw new MailCoreError('invalid_idempotency_input', 'Digest inputs must be finite.')
      }
      return Object.is(item, -0) ? '0' : JSON.stringify(item)
    }
    if (item instanceof Uint8Array) {
      return `{"$bytes":${JSON.stringify(bytesToBase64Url(item))}}`
    }
    if (item instanceof ArrayBuffer) return encode(new Uint8Array(item))
    if (item instanceof Date) {
      if (!Number.isFinite(item.getTime())) {
        throw new MailCoreError('invalid_idempotency_input', 'Digest dates must be valid.')
      }
      return `{"$date":${JSON.stringify(item.toISOString())}}`
    }
    if (Array.isArray(item)) {
      return withCycleGuard(item, () => `[${item.map((entry) => encode(entry)).join(',')}]`)
    }
    if (typeof item === 'object') {
      const record = item as Record<string, unknown>
      const prototype = Object.getPrototypeOf(record) as unknown
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MailCoreError(
          'invalid_idempotency_input',
          'Digest objects must be plain records.',
        )
      }
      return withCycleGuard(record, () => {
        const entries = Object.keys(record)
          .sort()
          .filter((key) => record[key] !== undefined)
          .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
        return `{${entries.join(',')}}`
      })
    }
    throw new MailCoreError(
      'invalid_idempotency_input',
      `Unsupported digest input type: ${typeof item}.`,
    )
  }

  const withCycleGuard = <T extends object>(object: T, callback: () => string): string => {
    if (active.has(object)) {
      throw new MailCoreError('invalid_idempotency_input', 'Digest inputs cannot be cyclic.')
    }
    active.add(object)
    try {
      return callback()
    } finally {
      active.delete(object)
    }
  }

  return encode(value)
}

function resolveCrypto(): WebCryptoLike {
  const provider = (globalThis as { crypto?: WebCryptoLike }).crypto
  if (!provider?.subtle) {
    throw new MailCoreError('missing_crypto', 'Web Crypto subtle.digest is unavailable.')
  }
  return provider
}

export function digestCanonicalParts(parts: readonly string[]): Uint8Array {
  // Length framing prevents ambiguous concatenations ("ab" + "c" vs "a" + "bc").
  return utf8Bytes(parts.map((part) => `${utf8Bytes(part).byteLength}:${part}`).join('|'))
}
