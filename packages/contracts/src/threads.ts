import { z } from '@hono/zod-openapi'

import { WorkflowStateSchema } from './folders'
import { CursorSchema, MailboxIdSchema, ThreadIdSchema } from './ids'
import { MessageSchema } from './messages'
import {
  IsoDateTimeSchema,
  NonNegativeIntegerSchema,
  NormalizedEmailAddressSchema,
  PreviewSchema,
  SubjectSchema,
} from './primitives'

export const ThreadParticipantSchema = z
  .object({
    address: NormalizedEmailAddressSchema,
    displayName: z.string().min(1).max(256).nullable(),
  })
  .strict()
  .openapi('ThreadParticipant')

export const TagSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
  })
  .strict()
  .openapi('Tag')

export const ThreadSummarySchema = z
  .object({
    id: ThreadIdSchema,
    mailboxId: MailboxIdSchema,
    subject: SubjectSchema,
    preview: PreviewSchema,
    participants: z.array(ThreadParticipantSchema).max(100),
    workflowState: WorkflowStateSchema,
    archivedAt: IsoDateTimeSchema.nullable(),
    lastMessageAt: IsoDateTimeSchema,
    lastMessageDirection: z.enum(['inbound', 'outbound']),
    messageCount: NonNegativeIntegerSchema,
    unreadCount: NonNegativeIntegerSchema,
    attachmentCount: NonNegativeIntegerSchema,
    tags: z.array(TagSchema).max(100),
  })
  .strict()
  .refine(
    (thread) => thread.unreadCount <= thread.messageCount,
    'Unread count cannot exceed message count',
  )
  .openapi('ThreadSummary')
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>

export const ThreadListResponseSchema = z
  .object({
    items: z.array(ThreadSummarySchema).max(50),
    nextCursor: CursorSchema.nullable(),
  })
  .strict()
  .openapi('ThreadListResponse')
export type ThreadListResponse = z.infer<typeof ThreadListResponseSchema>

export const ThreadDetailResponseSchema = z
  .object({
    thread: ThreadSummarySchema,
    messages: z.array(MessageSchema).max(10_000),
  })
  .strict()
  .superRefine((detail, context) => {
    if (detail.thread.messageCount !== detail.messages.length) {
      context.addIssue({
        code: 'custom',
        path: ['thread', 'messageCount'],
        message: 'Thread message count must match the detail messages',
      })
    }

    const unreadCount = detail.messages.filter(
      (message) => message.direction === 'inbound' && message.readAt === null,
    ).length
    if (detail.thread.unreadCount !== unreadCount) {
      context.addIssue({
        code: 'custom',
        path: ['thread', 'unreadCount'],
        message: 'Thread unread count must match unread inbound messages',
      })
    }

    const attachmentCount = detail.messages.reduce(
      (count, message) => count + message.attachments.length,
      0,
    )
    if (detail.thread.attachmentCount !== attachmentCount) {
      context.addIssue({
        code: 'custom',
        path: ['thread', 'attachmentCount'],
        message: 'Thread attachment count must match message attachments',
      })
    }

    detail.messages.forEach((message, index) => {
      if (message.threadId !== detail.thread.id || message.mailboxId !== detail.thread.mailboxId) {
        context.addIssue({
          code: 'custom',
          path: ['messages', index],
          message: 'Every message must belong to the response thread and mailbox',
        })
      }

      const previous = detail.messages[index - 1]
      if (
        previous !== undefined &&
        (Date.parse(previous.sentAt) > Date.parse(message.sentAt) ||
          (previous.sentAt === message.sentAt && previous.id > message.id))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['messages', index],
          message: 'Thread messages must be in chronological order',
        })
      }
    })
  })
  .openapi('ThreadDetailResponse')
export type ThreadDetailResponse = z.infer<typeof ThreadDetailResponseSchema>

export const ThreadPathParamsSchema = z.object({ threadId: ThreadIdSchema }).strict()

export const ThreadMutationResponseSchema = z
  .object({ thread: ThreadSummarySchema })
  .strict()
  .openapi('ThreadMutationResponse')
