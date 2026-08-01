const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** Creates a lower-case UUIDv7 using a 48-bit Unix-millisecond timestamp. */
export function createUuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError('UUIDv7 timestamp is outside the supported range.')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let timestamp = now
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff
    timestamp = Math.floor(timestamp / 256)
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f)
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f)
  const hexadecimal = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(16, 20)}-${hexadecimal.slice(20)}`
}

/** Generates an opaque lowercase base32 reply-alias token without embedded identifiers. */
export function createReplyAliasToken(byteLength = 20): string {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 48) {
    throw new RangeError('Reply-alias entropy must contain 16 to 48 bytes.')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength))
  let buffer = 0
  let bitCount = 0
  let output = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bitCount += 8
    while (bitCount >= 5) {
      bitCount -= 5
      output += BASE32_ALPHABET[(buffer >>> bitCount) & 31]
      buffer &= (1 << bitCount) - 1
    }
  }
  if (bitCount > 0) output += BASE32_ALPHABET[(buffer << (5 - bitCount)) & 31]
  return output
}
