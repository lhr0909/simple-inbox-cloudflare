import {
  buildThreadFallbackInput,
  normalizeInReplyTo,
  normalizeMessageId,
  normalizeReferences,
} from './headers'
import { containsControlCharacters } from './text'

export const DEFAULT_THREAD_FALLBACK_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000

export interface KnownThreadMessage {
  threadId: string
  mailboxId: string
  internetMessageId?: string | null
  providerMessageId?: string | null
}

export interface SubjectThreadCandidate {
  threadId: string
  mailboxId: string
  subject: string
  participants: readonly string[]
  latestMessageAt: string | number | Date
}

export interface ThreadResolutionInput {
  mailboxId: string
  receivedAt: string | number | Date
  subject: string | null | undefined
  participants: readonly string[]
  inReplyTo?: string | readonly string[] | null
  references?: string | readonly string[] | null
  replyAliasThreadId?: string | null
  knownMessages: readonly KnownThreadMessage[]
  fallbackCandidates: readonly SubjectThreadCandidate[]
  fallbackWindowMs?: number
}

export type ThreadResolution =
  | { kind: 'reply_alias'; threadId: string }
  | { kind: 'in_reply_to'; threadId: string; matchedMessageId: string }
  | { kind: 'references'; threadId: string; matchedMessageId: string }
  | { kind: 'subject_participants'; threadId: string }
  | { kind: 'new' }

export function resolveThread(input: ThreadResolutionInput): ThreadResolution {
  if (input.replyAliasThreadId) {
    return { kind: 'reply_alias', threadId: input.replyAliasThreadId }
  }

  const messageIndex = new Map<string, KnownThreadMessage>()
  for (const message of input.knownMessages) {
    if (message.mailboxId !== input.mailboxId) continue
    for (const rawId of [message.internetMessageId, message.providerMessageId]) {
      const id = comparableMessageId(rawId)
      if (id && !messageIndex.has(id)) messageIndex.set(id, message)
    }
  }

  const inReplyTo = normalizeInReplyTo(input.inReplyTo)
  if (inReplyTo) {
    const matched = messageIndex.get(comparableMessageId(inReplyTo) ?? '')
    if (matched) {
      return {
        kind: 'in_reply_to',
        threadId: matched.threadId,
        matchedMessageId: inReplyTo,
      }
    }
  }

  const references = normalizeReferences(input.references, {
    maxCount: 256,
    maxBytes: 64 * 1_024,
  })
  for (const reference of references.toReversed()) {
    const matched = messageIndex.get(comparableMessageId(reference) ?? '')
    if (matched) {
      return {
        kind: 'references',
        threadId: matched.threadId,
        matchedMessageId: reference,
      }
    }
  }

  const targetFallback = buildThreadFallbackInput(input)
  const receivedAt = toTimestamp(input.receivedAt)
  const windowMs = input.fallbackWindowMs ?? DEFAULT_THREAD_FALLBACK_WINDOW_MS
  if (targetFallback && Number.isFinite(receivedAt) && windowMs >= 0) {
    const candidates = input.fallbackCandidates
      .filter((candidate) => candidate.mailboxId === input.mailboxId)
      .map((candidate) => ({
        candidate,
        fallback: buildThreadFallbackInput(candidate),
        latestAt: toTimestamp(candidate.latestMessageAt),
      }))
      .filter(
        ({ fallback, latestAt }) =>
          fallback?.normalizedSubject === targetFallback.normalizedSubject &&
          fallback.participantKey === targetFallback.participantKey &&
          Number.isFinite(latestAt) &&
          latestAt <= receivedAt &&
          receivedAt - latestAt <= windowMs,
      )
      .sort(
        (left, right) =>
          right.latestAt - left.latestAt ||
          left.candidate.threadId.localeCompare(right.candidate.threadId),
      )
    const selected = candidates[0]?.candidate
    if (selected) return { kind: 'subject_participants', threadId: selected.threadId }
  }

  return { kind: 'new' }
}

function comparableMessageId(input: string | null | undefined): string | null {
  const normalized = normalizeMessageId(input)
  if (normalized) return normalized.toLocaleLowerCase('en-US')
  const opaque = input?.trim()
  if (!opaque || containsControlCharacters(opaque) || opaque.length > 500) {
    return null
  }
  return opaque.toLocaleLowerCase('en-US')
}

function toTimestamp(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}
