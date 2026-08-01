const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
  return output
}

export function bytesToBase64(bytes: Uint8Array): string {
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1] ?? 0
    const third = bytes[index + 2] ?? 0
    const combined = (first << 16) | (second << 8) | third

    output += BASE64_ALPHABET[(combined >>> 18) & 63]
    output += BASE64_ALPHABET[(combined >>> 12) & 63]
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(combined >>> 6) & 63] : '='
    output += index + 2 < bytes.length ? BASE64_ALPHABET[combined & 63] : '='
  }
  return output
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

export function wrapBase64(base64: string, width = 76): string {
  const lines: string[] = []
  for (let index = 0; index < base64.length; index += width) {
    lines.push(base64.slice(index, index + width))
  }
  return lines.join('\r\n')
}

export function normalizeCrlf(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, '\n').replaceAll('\n', '\r\n')
}

export function toBytes(value: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof value === 'string') return utf8Bytes(value)
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value)
}
