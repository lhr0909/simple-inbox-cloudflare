import { MailCoreError } from './errors'
import { containsControlCharacters, replaceControlCharacters, truncateCodePoints } from './text'

export const DEFAULT_MAX_RECIPIENTS = 50

export interface MailAddress {
  address: string
  name?: string
}

export type AddressFieldInput = string | readonly string[] | undefined

export interface RecipientFieldInput {
  to: AddressFieldInput
  cc?: AddressFieldInput
  bcc?: AddressFieldInput
}

export interface NormalizedRecipients {
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  count: number
}

export interface ParsedMailbox {
  address: string
  localPart: string
  domain: string
}

export interface NormalizeEnvelopeOptions {
  allowNullReversePath?: boolean
}

const ATOM = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/iu
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu

export function normalizeEmailAddress(input: string): string {
  const value = input.trim()
  if (containsControlCharacters(value, true)) {
    throw new MailCoreError(
      'invalid_address',
      'Email addresses cannot contain whitespace or control characters.',
    )
  }
  if (value.length > 254) {
    throw new MailCoreError('invalid_address', 'Email address exceeds 254 characters.')
  }

  const separator = value.lastIndexOf('@')
  if (separator <= 0 || separator !== value.indexOf('@')) {
    throw new MailCoreError('invalid_address', `Invalid email address: ${input}`)
  }

  const localPart = value.slice(0, separator)
  const domain = value.slice(separator + 1).toLowerCase()
  if (
    localPart.length > 64 ||
    localPart.startsWith('.') ||
    localPart.endsWith('.') ||
    localPart.includes('..') ||
    !ATOM.test(localPart)
  ) {
    throw new MailCoreError('invalid_address', `Invalid email local part: ${input}`)
  }
  if (domain.length === 0 || domain.length > 253) {
    throw new MailCoreError('invalid_address', `Invalid email domain: ${input}`)
  }

  const labels = domain.split('.')
  if (labels.some((label) => !DOMAIN_LABEL.test(label))) {
    throw new MailCoreError('invalid_address', `Invalid email domain: ${input}`)
  }

  // SMTP local parts are technically case-sensitive, but provider identity and
  // recipient deduplication are deliberately case-insensitive in this product.
  return `${localPart.toLowerCase()}@${domain}`
}

export function parseMailbox(input: string): ParsedMailbox {
  const address = normalizeEmailAddress(input)
  const separator = address.lastIndexOf('@')
  return {
    address,
    localPart: address.slice(0, separator),
    domain: address.slice(separator + 1),
  }
}

export function normalizeEnvelopeAddress(
  input: string | null | undefined,
  options: NormalizeEnvelopeOptions = {},
): string | null {
  const value = input?.trim() ?? ''
  if (options.allowNullReversePath && (value === '' || value === '<>')) return null
  return normalizeEmailAddress(value)
}

export function parseAddressList(input: AddressFieldInput): MailAddress[] {
  if (input === undefined) return []
  const values = typeof input === 'string' ? [input] : input
  const parsed: MailAddress[] = []

  for (const value of values) {
    if (/\r|\n/u.test(value)) {
      throw new MailCoreError('invalid_address', 'Address fields cannot contain newlines.')
    }
    for (const token of splitAddressList(value)) {
      if (token.trim()) parsed.push(parseAddressToken(token))
    }
  }
  return deduplicateAddresses(parsed)
}

export function normalizeRecipientFields(
  input: RecipientFieldInput,
  maxRecipients = DEFAULT_MAX_RECIPIENTS,
): NormalizedRecipients {
  if (!Number.isSafeInteger(maxRecipients) || maxRecipients < 1) {
    throw new MailCoreError('limit_exceeded', 'Recipient limit must be a positive integer.')
  }

  const seen = new Set<string>()
  const takeUnique = (addresses: MailAddress[]): MailAddress[] =>
    addresses.filter(({ address }) => {
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })

  const to = takeUnique(parseAddressList(input.to))
  if (to.length === 0) {
    throw new MailCoreError('invalid_address', 'At least one To recipient is required.')
  }
  const cc = takeUnique(parseAddressList(input.cc))
  const bcc = takeUnique(parseAddressList(input.bcc))
  const count = to.length + cc.length + bcc.length
  if (count > maxRecipients) {
    throw new MailCoreError(
      'limit_exceeded',
      `Recipient count ${count} exceeds the provider limit of ${maxRecipients}.`,
    )
  }
  return { to, cc, bcc, count }
}

export function deduplicateAddresses(addresses: readonly MailAddress[]): MailAddress[] {
  const byAddress = new Map<string, MailAddress>()
  for (const item of addresses) {
    const address = normalizeEmailAddress(item.address)
    if (byAddress.has(address)) continue
    const name = normalizeDisplayName(item.name)
    byAddress.set(address, name ? { address, name } : { address })
  }
  return [...byAddress.values()]
}

export function formatAddress(value: MailAddress): string {
  const address = normalizeEmailAddress(value.address)
  const name = normalizeDisplayName(value.name)
  if (!name) return address
  const escaped = name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  return `"${escaped}" <${address}>`
}

export interface ReplyAliasOptions {
  domain: string
}

/**
 * Parse a direct catch-all reply address such as `<opaque-token>@example.test`.
 * The former `reply+<opaque-token>` form remains readable during upgrades.
 */
export function parseReplyAlias(
  input: string,
  options: ReplyAliasOptions,
): { address: string; token: string } | null {
  const mailbox = parseMailbox(input)
  const expectedDomain = parseMailbox(`alias@${options.domain}`).domain
  if (mailbox.domain !== expectedDomain) return null

  const token = mailbox.localPart.startsWith('reply+')
    ? mailbox.localPart.slice('reply+'.length)
    : mailbox.localPart
  if (token.length < 16 || token.length > 80 || !/^[a-z2-7]+$/u.test(token)) {
    return null
  }
  return { address: mailbox.address, token }
}

function splitAddressList(value: string): string[] {
  const output: string[] = []
  let start = 0
  let quote = false
  let escaped = false
  let angleDepth = 0
  let commentDepth = 0

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote && character === '\\') {
      escaped = true
      continue
    }
    if (character === '"' && commentDepth === 0) {
      quote = !quote
      continue
    }
    if (quote) continue
    if (character === '(') commentDepth += 1
    else if (character === ')' && commentDepth > 0) commentDepth -= 1
    else if (character === '<' && commentDepth === 0) angleDepth += 1
    else if (character === '>' && angleDepth > 0) angleDepth -= 1
    else if ((character === ',' || character === ';') && angleDepth === 0 && commentDepth === 0) {
      output.push(value.slice(start, index))
      start = index + 1
    }
  }

  if (quote || angleDepth !== 0 || commentDepth !== 0) {
    throw new MailCoreError('invalid_address', 'Address field has unbalanced delimiters.')
  }
  output.push(value.slice(start))
  return output
}

function parseAddressToken(rawToken: string): MailAddress {
  const token = rawToken.trim()
  const angleStart = token.lastIndexOf('<')
  if (angleStart >= 0) {
    if (!token.endsWith('>') || token.indexOf('<') !== angleStart) {
      throw new MailCoreError('invalid_address', `Invalid mailbox syntax: ${rawToken}`)
    }
    const address = normalizeEmailAddress(token.slice(angleStart + 1, -1))
    const display = token.slice(0, angleStart).trim()
    const unquoted =
      display.startsWith('"') && display.endsWith('"')
        ? display.slice(1, -1).replace(/\\(["\\])/gu, '$1')
        : display.replace(/\s*\([^)]*\)\s*$/u, '')
    const name = normalizeDisplayName(unquoted)
    return name ? { address, name } : { address }
  }

  return { address: normalizeEmailAddress(token.replace(/\s*\([^)]*\)\s*$/u, '')) }
}

function normalizeDisplayName(input: string | undefined): string | undefined {
  if (input === undefined) return undefined
  const value = replaceControlCharacters(input, ' ').replace(/\s+/gu, ' ').trim()
  return value ? truncateCodePoints(value, 256) : undefined
}
