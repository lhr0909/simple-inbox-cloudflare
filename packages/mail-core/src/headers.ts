import { normalizeEmailAddress } from './address'
import { replaceControlCharacters, truncateCodePoints } from './text'

export const DEFAULT_SUBJECT = 'No subject'
export const MAX_SUBJECT_CHARACTERS = 998
export const DEFAULT_MAX_REFERENCES = 32
export const DEFAULT_MAX_REFERENCES_BYTES = 900

const BRACKETED_MESSAGE_ID = /<([^<>\s]+)>/gu
const MESSAGE_ID_BODY = /^[^\s<>(),;:\\"[\]]+@[^\s<>(),;:\\"[\]]+$/u
const LEADING_THREAD_PREFIX = /^(?:(?:re|fw|fwd)\s*(?:\[\d+\])?\s*:\s*)+/iu
const LEADING_REPLY_PREFIX = /^(?:re\s*(?:\[\d+\])?\s*:\s*)+/iu

export function cleanHeaderText(input: string | null | undefined): string {
  return replaceControlCharacters(input ?? '', ' ', [0x09])
    .replace(/\s+/gu, ' ')
    .trim()
}

export function normalizeSubject(
  input: string | null | undefined,
  fallback = DEFAULT_SUBJECT,
): string {
  const subject = cleanHeaderText(input) || fallback
  return truncateCodePoints(subject, MAX_SUBJECT_CHARACTERS)
}

export function normalizeSubjectForThreading(input: string | null | undefined): string {
  return normalizeSubject(input, '')
    .replace(LEADING_THREAD_PREFIX, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US')
}

export function ensureReplySubject(input: string | null | undefined): string {
  const subject = normalizeSubject(input)
  const withoutReplies = subject.replace(LEADING_REPLY_PREFIX, '').trim()
  return truncateCodePoints(`Re: ${withoutReplies || DEFAULT_SUBJECT}`, MAX_SUBJECT_CHARACTERS)
}

export function normalizeMessageId(input: string | null | undefined): string | null {
  const value = cleanHeaderText(input)
  if (!value) return null

  BRACKETED_MESSAGE_ID.lastIndex = 0
  const bracketed = BRACKETED_MESSAGE_ID.exec(value)?.[1]
  const candidate = bracketed ?? (/^\S+@\S+$/u.test(value) ? value : null)
  if (!candidate || candidate.length > 500 || !MESSAGE_ID_BODY.test(candidate)) return null

  const separator = candidate.lastIndexOf('@')
  const left = candidate.slice(0, separator)
  const right = candidate.slice(separator + 1).toLowerCase()
  if (!left || !right || left.startsWith('.') || left.endsWith('.')) return null
  return `<${left}@${right}>`
}

export function normalizeInReplyTo(
  input: string | readonly string[] | null | undefined,
): string | null {
  const values = normalizeMessageIdSequence(input)
  return values.at(-1) ?? null
}

export interface ReferenceNormalizationOptions {
  maxCount?: number
  maxBytes?: number
}

export function normalizeReferences(
  input: string | readonly string[] | null | undefined,
  options: ReferenceNormalizationOptions = {},
): string[] {
  const maxCount = options.maxCount ?? DEFAULT_MAX_REFERENCES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_REFERENCES_BYTES
  if (maxCount <= 0 || maxBytes <= 0) return []

  const seen = new Set<string>()
  const uniqueNewestFirst = normalizeMessageIdSequence(input)
    .toReversed()
    .filter((id) => {
      const comparable = id.toLocaleLowerCase('en-US')
      if (seen.has(comparable)) return false
      seen.add(comparable)
      return true
    })
  const unique = uniqueNewestFirst.reverse()
  const keptNewestFirst: string[] = []
  let bytes = 0
  for (const id of unique.toReversed()) {
    const nextBytes = new TextEncoder().encode(id).byteLength + (keptNewestFirst.length ? 1 : 0)
    if (keptNewestFirst.length >= maxCount || bytes + nextBytes > maxBytes) break
    keptNewestFirst.push(id)
    bytes += nextBytes
  }
  return keptNewestFirst.reverse()
}

export function appendReference(
  references: string | readonly string[] | null | undefined,
  parentId: string | null | undefined,
  options: ReferenceNormalizationOptions = {},
): string[] {
  return normalizeReferences(
    [...normalizeMessageIdSequence(references), ...(parentId ? [parentId] : [])],
    options,
  )
}

export interface ThreadFallbackInput {
  normalizedSubject: string
  participantKey: string
}

export function buildThreadFallbackInput(input: {
  subject: string | null | undefined
  participants: readonly string[]
}): ThreadFallbackInput | null {
  const normalizedSubject = normalizeSubjectForThreading(input.subject)
  if (!normalizedSubject) return null

  const participants = new Set<string>()
  for (const participant of input.participants) {
    try {
      participants.add(normalizeEmailAddress(participant))
    } catch {
      // Invalid display/header data must not make a conservative fallback less safe.
      return null
    }
  }
  if (participants.size === 0) return null
  return {
    normalizedSubject,
    participantKey: [...participants].sort().join('\u001f'),
  }
}

function normalizeMessageIdSequence(
  input: string | readonly string[] | null | undefined,
): string[] {
  if (input === null || input === undefined) return []
  const values = typeof input === 'string' ? [input] : input
  const output: string[] = []

  for (const value of values) {
    const cleaned = cleanHeaderText(value)
    BRACKETED_MESSAGE_ID.lastIndex = 0
    let foundBracketed = false
    for (const match of cleaned.matchAll(BRACKETED_MESSAGE_ID)) {
      foundBracketed = true
      const normalized = normalizeMessageId(match[0])
      if (normalized) output.push(normalized)
    }
    if (foundBracketed) continue

    for (const token of cleaned.split(/[\s,]+/u)) {
      const normalized = normalizeMessageId(token)
      if (normalized) output.push(normalized)
    }
  }
  return output
}
