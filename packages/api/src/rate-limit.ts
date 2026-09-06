import { sha256Hex } from '@cloudflare-inbox/mail-core'

export async function allowedByRateLimiters(
  binding: RateLimit,
  keys: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        return (await binding.limit({ key })).success
      } catch {
        return false
      }
    }),
  )
  return results.every(Boolean)
}

export async function rateLimitKeyForSource(prefix: string, request: Request): Promise<string> {
  const source = trustedSourceNetwork(request)
  if (source === undefined) return `${prefix}:unavailable`
  return `${prefix}:${(await sha256Hex(source)).slice(0, 40)}`
}

/**
 * `CF-Connecting-IP` is authoritative only after a request has traversed the
 * Cloudflare edge. Requiring runtime-only `request.cf` metadata prevents a
 * caller from manufacturing rate-limit buckets with a spoofed header.
 */
function trustedSourceNetwork(request: Request): string | undefined {
  if (request.cf === undefined) return undefined

  const value = request.headers.get('cf-connecting-ip')?.trim()
  if (value === undefined || value.length === 0) return undefined

  const ipv4 = parseIpv4(value)
  if (ipv4 !== undefined) return ipv4.join('.')

  const ipv6 = parseIpv6(value)
  if (ipv6 === undefined) return undefined
  return `${ipv6
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(':')}::/64`
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined

  const octets = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return Number.NaN
    return Number(part)
  })
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : undefined
}

function parseIpv6(value: string): number[] | undefined {
  if (!/^[0-9A-Fa-f:.]+$/u.test(value) || !value.includes(':')) return undefined

  let canonical = value
  if (canonical.includes('.')) {
    const separator = canonical.lastIndexOf(':')
    const ipv4 = separator < 0 ? undefined : parseIpv4(canonical.slice(separator + 1))
    if (ipv4 === undefined) return undefined
    canonical = `${canonical.slice(0, separator)}:${((ipv4[0] ?? 0) * 256 + (ipv4[1] ?? 0)).toString(16)}:${((ipv4[2] ?? 0) * 256 + (ipv4[3] ?? 0)).toString(16)}`
  }

  const compressed = canonical.split('::')
  if (compressed.length > 2) return undefined
  const left = parseIpv6Parts(compressed[0] ?? '')
  const right = parseIpv6Parts(compressed[1] ?? '')
  if (left === undefined || right === undefined) return undefined

  if (compressed.length === 1) return left.length === 8 ? left : undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

function parseIpv6Parts(value: string): number[] | undefined {
  if (value.length === 0) return []
  const parts = value.split(':')
  if (parts.some((part) => !/^[0-9A-Fa-f]{1,4}$/u.test(part))) return undefined
  return parts.map((part) => Number.parseInt(part, 16))
}
