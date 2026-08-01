import { parseAddressList, type MailAddress } from './address'
import { ensureReplySubject } from './headers'

export interface ReplyTargetMessage {
  id: string
  direction: 'inbound' | 'outbound'
  sentAt: string | number | Date
  from: string
  replyTo?: string | readonly string[] | null
}

export interface SelectedReplyTarget {
  address: MailAddress
  messageId: string
  source: 'reply_to' | 'from'
}

export function selectReplyTarget(
  messages: readonly ReplyTargetMessage[],
  selectedMessageId?: string | null,
): SelectedReplyTarget | null {
  const explicitlySelected = selectedMessageId
    ? messages.find(
        (message) => message.id === selectedMessageId && message.direction === 'inbound',
      )
    : undefined
  const target = explicitlySelected ?? latestInbound(messages)
  if (!target) return null

  const replyTo = tryParse(target.replyTo)
  if (replyTo) {
    return { address: replyTo, messageId: target.id, source: 'reply_to' }
  }
  const from = tryParse(target.from)
  return from ? { address: from, messageId: target.id, source: 'from' } : null
}

export { ensureReplySubject }

function latestInbound(messages: readonly ReplyTargetMessage[]): ReplyTargetMessage | undefined {
  return messages
    .filter((message) => message.direction === 'inbound')
    .toSorted(
      (left, right) =>
        new Date(right.sentAt).getTime() - new Date(left.sentAt).getTime() ||
        right.id.localeCompare(left.id),
    )[0]
}

function tryParse(input: string | readonly string[] | null | undefined): MailAddress | null {
  try {
    return parseAddressList(input ?? undefined)[0] ?? null
  } catch {
    return null
  }
}
