import {
  MailboxSettingsSchema,
  MailboxSummarySchema,
  MessageSchema,
  ThreadDetailResponseSchema,
  ThreadSummarySchema,
  type MailboxSettings,
  type MailboxSummary,
  type Message,
  type ThreadDetailResponse,
  type ThreadFolder,
  type ThreadSummary,
} from '@cloudflare-inbox/contracts'
import type {
  MailboxSettings as DatabaseMailboxSettings,
  MailboxSummary as DatabaseMailboxSummary,
  ThreadDetailProjection,
  ThreadFolder as DatabaseThreadFolder,
  ThreadSummary as DatabaseThreadSummary,
} from '@cloudflare-inbox/db'

import { isoDate } from './http'

export function projectMailboxSummary(mailbox: DatabaseMailboxSummary): MailboxSummary {
  return MailboxSummarySchema.parse({
    address: mailbox.address,
    counts: {
      all: mailbox.activeCount,
      archive: mailbox.archiveCount,
      needsReply: mailbox.needsReplyCount,
      sent: mailbox.sentCount,
      unread: mailbox.unreadCount,
    },
    createdAt: isoDate(mailbox.createdAt),
    forwardTo: mailbox.forwardTo,
    forwardHtml: mailbox.forwardHtml,
    renderHtml: mailbox.renderHtml,
    id: mailbox.id,
    senderAlias: mailbox.senderAlias,
    updatedAt: isoDate(mailbox.updatedAt),
  })
}

export function projectMailboxSettings(mailbox: DatabaseMailboxSettings): MailboxSettings {
  return MailboxSettingsSchema.parse({
    address: mailbox.address,
    forwardTo: mailbox.forwardTo,
    forwardHtml: mailbox.forwardHtml,
    renderHtml: mailbox.renderHtml,
    id: mailbox.id,
    senderAlias: mailbox.senderAlias,
    updatedAt: isoDate(mailbox.updatedAt),
  })
}

export function projectThreadSummary(thread: DatabaseThreadSummary): ThreadSummary {
  return ThreadSummarySchema.parse({
    archivedAt: thread.archivedAt === null ? null : isoDate(thread.archivedAt),
    attachmentCount: thread.attachmentCount,
    id: thread.id,
    lastMessageAt: isoDate(thread.lastMessageAt),
    lastMessageDirection: thread.lastMessageDirection,
    mailboxId: thread.mailboxId,
    messageCount: thread.messageCount,
    participants: thread.participants,
    preview: thread.lastMessagePreview,
    subject: thread.subject,
    tags: thread.tags,
    unreadCount: thread.unreadCount,
    workflowState: thread.workflowState,
  })
}

export function projectThreadDetail(detail: ThreadDetailProjection): ThreadDetailResponse {
  const messages = detail.messages.map(projectMessage)
  return ThreadDetailResponseSchema.parse({
    messages,
    thread: projectThreadSummary(detail.thread),
  })
}

export function projectMessage(message: ThreadDetailProjection['messages'][number]): Message {
  return MessageSchema.parse({
    attachments: message.attachments,
    direction: message.direction,
    failure: message.failure,
    forwardState: message.forwardState,
    from: message.from,
    htmlBody: message.htmlBody,
    htmlPolicy: message.htmlPolicy,
    id: message.id,
    inReplyTo: message.inReplyTo,
    internetMessageId: message.internetMessageId,
    mailboxId: message.mailboxId,
    preview: message.preview,
    rawAvailable: message.rawAvailable,
    rawSize: message.rawSize,
    readAt: message.readAt === null ? null : isoDate(message.readAt),
    receivedAt: message.receivedAt === null ? null : isoDate(message.receivedAt),
    recipients: message.recipients,
    references: message.references,
    sendState: message.sendState,
    sentAt: isoDate(message.sentAt),
    subject: message.subject,
    textBody: message.textBody ?? '',
    threadId: message.threadId,
  })
}

export function databaseFolder(folder: ThreadFolder): DatabaseThreadFolder {
  return folder === 'needs-reply' ? 'needs_reply' : folder
}
