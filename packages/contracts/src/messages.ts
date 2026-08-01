import { z } from '@hono/zod-openapi'

import { AttachmentIdSchema, MailboxIdSchema, MessageIdSchema, ThreadIdSchema } from './ids'
import {
  DisplayNameSchema,
  FileNameSchema,
  HtmlBodySchema,
  IsoDateTimeSchema,
  MediaTypeSchema,
  NonNegativeIntegerSchema,
  NormalizedEmailAddressSchema,
  PlainTextBodySchema,
  PreviewSchema,
  SubjectSchema,
} from './primitives'

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const
export const MessageDirectionSchema = z.enum(MESSAGE_DIRECTIONS)
export type MessageDirection = z.infer<typeof MessageDirectionSchema>

export const VISIBLE_RECIPIENT_KINDS = ['to', 'cc', 'bcc', 'reply_to'] as const
export const VisibleRecipientKindSchema = z.enum(VISIBLE_RECIPIENT_KINDS)
export type VisibleRecipientKind = z.infer<typeof VisibleRecipientKindSchema>

export const AddressSchema = z
  .object({
    address: NormalizedEmailAddressSchema,
    displayName: DisplayNameSchema.nullable(),
  })
  .strict()
  .openapi('Address')
export type Address = z.infer<typeof AddressSchema>

export const MessageRecipientSchema = z
  .object({
    kind: VisibleRecipientKindSchema,
    position: NonNegativeIntegerSchema,
    address: NormalizedEmailAddressSchema,
    displayName: DisplayNameSchema.nullable(),
  })
  .strict()
  .openapi('MessageRecipient')
export type MessageRecipient = z.infer<typeof MessageRecipientSchema>

export const AttachmentMetadataSchema = z
  .object({
    id: AttachmentIdSchema,
    ordinal: NonNegativeIntegerSchema,
    filename: FileNameSchema.nullable(),
    mediaType: MediaTypeSchema,
    size: NonNegativeIntegerSchema,
    disposition: z.enum(['attachment', 'inline', 'unknown']),
    contentId: z.string().max(998).nullable(),
  })
  .strict()
  .openapi('AttachmentMetadata')
export type AttachmentMetadata = z.infer<typeof AttachmentMetadataSchema>

export const HtmlPolicySchema = z.enum(['none', 'sanitized', 'blocked'])
export type HtmlPolicy = z.infer<typeof HtmlPolicySchema>

export const SendStateSchema = z.enum([
  'not_applicable',
  'queued',
  'sending',
  'sent',
  'failed',
  'unknown',
])
export type SendState = z.infer<typeof SendStateSchema>

export const ForwardStateSchema = z.enum([
  'not_applicable',
  'pending',
  'forwarded',
  'failed',
  'unknown',
])
export type ForwardState = z.infer<typeof ForwardStateSchema>

export const DELIVERY_RETRYABILITIES = [
  'not_retryable',
  'retryable',
  'manual_confirmation_required',
] as const
export const DeliveryRetryabilitySchema = z.enum(DELIVERY_RETRYABILITIES)
export type DeliveryRetryability = z.infer<typeof DeliveryRetryabilitySchema>

export const DeliveryFailureSchema = z
  .object({
    retryability: DeliveryRetryabilitySchema,
    safeErrorCode: z.string().min(1).max(128),
  })
  .strict()
  .openapi('DeliveryFailure')
export type DeliveryFailure = z.infer<typeof DeliveryFailureSchema>

export const MessageSchema = z
  .object({
    id: MessageIdSchema,
    mailboxId: MailboxIdSchema,
    threadId: ThreadIdSchema,
    direction: MessageDirectionSchema,
    internetMessageId: z.string().max(998).nullable(),
    inReplyTo: z.string().max(998).nullable(),
    from: AddressSchema,
    recipients: z.array(MessageRecipientSchema).max(200),
    references: z.array(z.string().max(998)).max(100),
    subject: SubjectSchema,
    preview: PreviewSchema,
    textBody: PlainTextBodySchema,
    htmlBody: HtmlBodySchema.nullable(),
    htmlPolicy: HtmlPolicySchema,
    sentAt: IsoDateTimeSchema,
    receivedAt: IsoDateTimeSchema.nullable(),
    readAt: IsoDateTimeSchema.nullable(),
    sendState: SendStateSchema,
    forwardState: ForwardStateSchema,
    failure: DeliveryFailureSchema.nullable(),
    rawAvailable: z.boolean(),
    rawSize: NonNegativeIntegerSchema.nullable(),
    attachments: z.array(AttachmentMetadataSchema).max(100),
  })
  .strict()
  .superRefine((message, context) => {
    if (
      message.direction === 'inbound' &&
      message.recipients.some((recipient) => recipient.kind === 'bcc')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['recipients'],
        message: 'Inbound blind recipients must not cross the public API boundary',
      })
    }
    if (message.direction === 'outbound' && message.readAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['readAt'],
        message: 'Outbound messages cannot be unread',
      })
    }
    if (message.direction === 'inbound' && message.sendState !== 'not_applicable') {
      context.addIssue({
        code: 'custom',
        path: ['sendState'],
        message: 'Inbound messages do not have an outbound send state',
      })
    }
    if (message.direction === 'outbound' && message.forwardState !== 'not_applicable') {
      context.addIssue({
        code: 'custom',
        path: ['forwardState'],
        message: 'Outbound messages do not have an owner-forwarding state',
      })
    }
    const state = message.direction === 'inbound' ? message.forwardState : message.sendState
    const isFailure = state === 'failed' || state === 'unknown'
    if (isFailure !== (message.failure !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'Delivery failures must expose one safe failure classification',
      })
    }
    if (state === 'unknown' && message.failure?.retryability !== 'manual_confirmation_required') {
      context.addIssue({
        code: 'custom',
        path: ['failure', 'retryability'],
        message: 'Unknown provider outcomes require manual confirmation before retrying',
      })
    }
    if (state === 'failed' && message.failure?.retryability !== 'not_retryable') {
      context.addIssue({
        code: 'custom',
        path: ['failure', 'retryability'],
        message: 'Definite delivery failures cannot be replayed automatically',
      })
    }
  })
  .openapi('Message')
export type Message = z.infer<typeof MessageSchema>

export const MessagePathParamsSchema = z.object({ messageId: MessageIdSchema }).strict()

export const AttachmentPathParamsSchema = z
  .object({
    messageId: MessageIdSchema,
    attachmentId: AttachmentIdSchema,
  })
  .strict()
