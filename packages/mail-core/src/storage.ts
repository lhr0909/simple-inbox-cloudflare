import { bytesToBase64Url, utf8Bytes } from './encoding'
import { MailCoreError } from './errors'
import { containsControlCharacters } from './text'

export type RawMessageDirection = 'inbound' | 'outbound'

export function buildInboundRawKey(receivedAt: string | number | Date, rawSha256: string): string {
  const digest = rawSha256.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(digest)) {
    throw new MailCoreError(
      'invalid_storage_key_input',
      'Inbound raw keys require a hexadecimal SHA-256 digest.',
    )
  }
  return `raw/inbound/${datePath(receivedAt)}/${digest}.eml`
}

export function buildOutboundRawKey(
  sentAt: string | number | Date,
  messageIdOrSendId: string,
): string {
  const stableIdBytes = utf8Bytes(messageIdOrSendId)
  if (
    !messageIdOrSendId ||
    messageIdOrSendId.length > 500 ||
    stableIdBytes.byteLength > 600 ||
    containsControlCharacters(messageIdOrSendId)
  ) {
    throw new MailCoreError(
      'invalid_storage_key_input',
      'Outbound raw keys require a bounded, non-empty stable ID.',
    )
  }
  // Base64url makes even an accidentally user-controlled ID a single inert key
  // segment: no slash, dot-segment, percent-decoding, or filename can escape it.
  const segment = bytesToBase64Url(stableIdBytes)
  return `raw/outbound/${datePath(sentAt)}/id-${segment}.eml`
}

export function buildRawMessageKey(
  input:
    | {
        direction: 'inbound'
        occurredAt: string | number | Date
        rawSha256: string
      }
    | {
        direction: 'outbound'
        occurredAt: string | number | Date
        stableId: string
      },
): string {
  return input.direction === 'inbound'
    ? buildInboundRawKey(input.occurredAt, input.rawSha256)
    : buildOutboundRawKey(input.occurredAt, input.stableId)
}

function datePath(input: string | number | Date): string {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input)
  if (!Number.isFinite(date.getTime())) {
    throw new MailCoreError('invalid_storage_key_input', 'Raw key date is invalid.')
  }
  return [
    date.getUTCFullYear().toString().padStart(4, '0'),
    (date.getUTCMonth() + 1).toString().padStart(2, '0'),
    date.getUTCDate().toString().padStart(2, '0'),
  ].join('/')
}
