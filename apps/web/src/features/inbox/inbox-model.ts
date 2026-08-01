import type { Message } from '@cloudflare-inbox/contracts/messages'
import type { ThreadFolder } from '@cloudflare-inbox/contracts/folders'
import type { ThreadSummary } from '@cloudflare-inbox/contracts/threads'
import type { ThreadListResponse } from '@cloudflare-inbox/contracts/threads'
import {
  MAX_ATTACHMENTS_PER_SEND,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '@cloudflare-inbox/contracts/send'

import type { InboxData, InboxQuery, OptimisticThreadState } from './inbox-types'

const MAX_SUBJECT_LENGTH = 998

export type MessageDeliveryPresentation = Readonly<{
  label: string
  notice: string | null
  variant: 'destructive' | 'outline' | 'secondary'
}>

export function messageDeliveryPresentation(
  message: Pick<Message, 'direction' | 'failure' | 'forwardState' | 'sendState'>,
): MessageDeliveryPresentation | null {
  const reference = message.failure ? ` Reference: ${message.failure.safeErrorCode}.` : ''

  if (message.direction === 'outbound') {
    switch (message.sendState) {
      case 'sent':
        return { label: 'Sent', notice: null, variant: 'outline' }
      case 'queued':
      case 'sending':
        return {
          label: 'Processing',
          notice: 'Delivery is still processing.',
          variant: 'secondary',
        }
      case 'failed':
        return {
          label: 'Send failed',
          notice: `This message was not delivered. Correct the issue before creating a new send.${reference}`,
          variant: 'destructive',
        }
      case 'unknown':
        return {
          label: 'Delivery unknown',
          notice: `Delivery could not be confirmed. Do not retry automatically; confirm the outcome with the recipient or provider first.${reference}`,
          variant: 'destructive',
        }
      case 'not_applicable':
        return null
    }
  }

  switch (message.forwardState) {
    case 'forwarded':
      return { label: 'Forwarded', notice: null, variant: 'outline' }
    case 'pending':
      return {
        label: 'Forwarding',
        notice: 'Forwarding to the configured destination is still processing.',
        variant: 'secondary',
      }
    case 'failed':
      return {
        label: 'Forward failed',
        notice: `Forwarding failed. The message remains safely available in this inbox.${reference}`,
        variant: 'destructive',
      }
    case 'unknown':
      return {
        label: 'Forwarding unknown',
        notice: `Forwarding could not be confirmed. Do not retry automatically; check the provider outcome first. The message remains available here.${reference}`,
        variant: 'destructive',
      }
    case 'not_applicable':
      return null
  }
}

export function threadMatchesFolder(thread: ThreadSummary, folder: ThreadFolder): boolean {
  switch (folder) {
    case 'all':
      return thread.archivedAt === null
    case 'archive':
      return thread.archivedAt !== null
    case 'needs-reply':
      return thread.archivedAt === null && thread.workflowState === 'needs_reply'
    case 'sent':
      return thread.archivedAt === null && thread.lastMessageDirection === 'outbound'
  }
}

export function filterThreads(
  threads: readonly ThreadSummary[],
  folder: ThreadFolder,
  unreadOnly: boolean,
  search: string,
): ThreadSummary[] {
  const needle = search.trim().toLocaleLowerCase()

  return threads.filter((thread) => {
    if (!threadMatchesFolder(thread, folder)) return false
    if (unreadOnly && thread.unreadCount === 0) return false
    if (!needle) return true

    return [
      thread.subject,
      thread.preview,
      ...thread.participants.flatMap((participant) => [
        participant.address,
        participant.displayName ?? '',
      ]),
    ].some((value) => value.toLocaleLowerCase().includes(needle))
  })
}

export function participantLabel(thread: ThreadSummary): string {
  const participant = thread.participants[0]
  return participant?.displayName ?? participant?.address ?? 'Unknown sender'
}

export function initials(label: string): string {
  const parts = label.trim().split(/\s+/u).filter(Boolean).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?'
}

export function formatMessageTime(value: string, now = new Date()): string {
  const date = new Date(value)
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat('en', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export function visibleRecipients(message: Message, kind: 'to' | 'cc' | 'bcc'): string {
  return message.recipients
    .filter((recipient) => recipient.kind === kind)
    .sort((left, right) => left.position - right.position)
    .map((recipient) => recipient.displayName ?? recipient.address)
    .join(', ')
}

export function defaultReplyRecipients(message: Message): string {
  const replyTo = message.recipients.find((recipient) => recipient.kind === 'reply_to')
  return replyTo?.address ?? message.from.address
}

export function inboundReplyTargets(messages: readonly Message[]): Message[] {
  return messages.filter((message) => message.direction === 'inbound')
}

export function replySubject(subject: string): string {
  if (/^\s*re:/iu.test(subject)) return subject.slice(0, MAX_SUBJECT_LENGTH)
  return `Re: ${subject}`.slice(0, MAX_SUBJECT_LENGTH)
}

export function attachmentLimitError(
  attachments: readonly Readonly<{ size: number }>[],
): string | null {
  if (attachments.length > MAX_ATTACHMENTS_PER_SEND) {
    return `Attach at most ${MAX_ATTACHMENTS_PER_SEND} files.`
  }
  if (attachments.some((attachment) => attachment.size > MAX_ATTACHMENT_BYTES)) {
    return 'Each attachment must be 10 MiB or smaller.'
  }
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0)
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) return 'Attachments must total 20 MiB or less.'
  return null
}

export function applyOptimisticThreadStates(
  data: InboxData,
  updates: Readonly<Record<string, OptimisticThreadState>>,
  visibility?: Pick<InboxQuery, 'folder' | 'unreadOnly'>,
): InboxData {
  const projectedThreads = data.threads.map((thread) =>
    applyThreadState(thread, updates[thread.id]),
  )
  const threads =
    visibility === undefined
      ? projectedThreads
      : projectedThreads.filter(
          (thread) =>
            threadMatchesFolder(thread, visibility.folder) &&
            (!visibility.unreadOnly || thread.unreadCount > 0),
        )
  const mailboxes = data.mailboxes.map((mailbox) => {
    const counts = { ...mailbox.counts }

    for (const thread of data.threads) {
      if (thread.mailboxId !== mailbox.id) continue
      const projected = applyThreadState(thread, updates[thread.id])

      const previousUnread = thread.archivedAt === null ? thread.unreadCount : 0
      const projectedUnread = projected.archivedAt === null ? projected.unreadCount : 0
      counts.unread = Math.max(0, counts.unread + projectedUnread - previousUnread)
      if ((thread.archivedAt !== null) !== (projected.archivedAt !== null)) {
        const archiveDelta = projected.archivedAt === null ? -1 : 1
        counts.archive += archiveDelta
        counts.all -= archiveDelta
        if (thread.workflowState === 'needs_reply') counts.needsReply -= archiveDelta
        if (thread.lastMessageDirection === 'outbound') counts.sent -= archiveDelta
      }
    }

    return { ...mailbox, counts }
  })

  const selectedThread = data.selectedThread
  if (selectedThread === null) return { ...data, mailboxes, threads }

  const update = updates[selectedThread.thread.id]
  if (update === undefined) return { ...data, mailboxes, threads }
  const readAt = update.readAt

  return {
    ...data,
    mailboxes,
    threads,
    selectedThread: {
      ...selectedThread,
      thread: applyThreadState(selectedThread.thread, update),
      messages:
        update.unreadCount === 0 && readAt !== undefined
          ? selectedThread.messages.map((message) =>
              message.direction === 'inbound' && message.readAt === null
                ? { ...message, readAt }
                : message,
            )
          : selectedThread.messages,
    },
  }
}

function applyThreadState(
  thread: ThreadSummary,
  update: OptimisticThreadState | undefined,
): ThreadSummary {
  if (update === undefined) return thread
  return {
    ...thread,
    ...(update.archivedAt === undefined ? {} : { archivedAt: update.archivedAt }),
    ...(update.unreadCount === undefined ? {} : { unreadCount: update.unreadCount }),
  }
}

export function clampPaneSize(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function appendThreadPage(data: InboxData, page: ThreadListResponse): InboxData {
  const knownIds = new Set(data.threads.map((thread) => thread.id))
  return {
    ...data,
    threads: [
      ...data.threads,
      ...page.items.filter((thread) => {
        if (knownIds.has(thread.id)) return false
        knownIds.add(thread.id)
        return true
      }),
    ],
    nextCursor: page.nextCursor,
  }
}
