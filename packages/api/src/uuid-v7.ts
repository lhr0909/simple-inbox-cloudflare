/** Creates a lower-case UUIDv7 using a Unix-millisecond timestamp and Web Crypto randomness. */
export function createUuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffff_ffff_ffff) {
    throw new RangeError('UUIDv7 timestamp is outside the 48-bit Unix millisecond range.')
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
