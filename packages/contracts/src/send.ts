import { z } from '@hono/zod-openapi'

import {
  IdempotencyKeySchema,
  MailboxIdSchema,
  MessageIdSchema,
  OutboundSendIdSchema,
  ThreadIdSchema,
} from './ids'
import {
  DisplayNameSchema,
  EmailAddressSchema,
  FileNameSchema,
  IsoDateTimeSchema,
  MediaTypeSchema,
  NonNegativeIntegerSchema,
  PlainTextBodySchema,
  SubjectSchema,
} from './primitives'
import { DeliveryRetryabilitySchema } from './messages'

// Cloudflare Email Sending currently accepts at most 50 combined recipients.
// Keep the public contract at the provider boundary so a request cannot pass
// validation only to fail later inside the private mail module.
export const MAX_RECIPIENTS_PER_SEND = 50
export const MAX_ATTACHMENTS_PER_SEND = 20
export const MAX_ATTACHMENT_BYTES = 10 * 1_024 * 1_024
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1_024 * 1_024

export const RecipientInputSchema = z
  .object({
    address: EmailAddressSchema,
    displayName: DisplayNameSchema.optional(),
  })
  .strict()
  .openapi('RecipientInput')
export type RecipientInput = z.infer<typeof RecipientInputSchema>

const RecipientListSchema = z.array(RecipientInputSchema).max(MAX_RECIPIENTS_PER_SEND)

export const AttachmentUploadDescriptorSchema = z
  .object({
    filename: FileNameSchema,
    mediaType: MediaTypeSchema,
    size: NonNegativeIntegerSchema,
  })
  .strict()
  .openapi('AttachmentUploadDescriptor')
export type AttachmentUploadDescriptor = z.infer<typeof AttachmentUploadDescriptorSchema>

const ComposeFieldsShape = {
  to: RecipientListSchema.min(1),
  cc: RecipientListSchema.optional(),
  bcc: RecipientListSchema.optional(),
  subject: SubjectSchema,
  body: PlainTextBodySchema.refine(
    (body) => body.trim().length > 0,
    'Message body must not be empty',
  ),
  format: z.enum(['plain', 'markdown']),
  attachments: z.array(AttachmentUploadDescriptorSchema).max(MAX_ATTACHMENTS_PER_SEND).optional(),
} as const

const RecipientFormFieldSchema = z.string().trim().min(3).max(512)

const RecipientFormListSchema = z
  .union([
    RecipientFormFieldSchema,
    z.array(RecipientFormFieldSchema).min(1).max(MAX_RECIPIENTS_PER_SEND),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]))

export const MultipartAttachmentSchema = z
  .custom<File>(
    (value) => typeof File !== 'undefined' && value instanceof File,
    'Expected a file upload',
  )
  .refine(
    (file) => file.size <= MAX_ATTACHMENT_BYTES,
    `Each attachment must be at most ${MAX_ATTACHMENT_BYTES} bytes`,
  )
  .openapi({ type: 'string', format: 'binary' })

export const MultipartAttachmentListSchema = z
  .union([
    MultipartAttachmentSchema,
    z.array(MultipartAttachmentSchema).min(1).max(MAX_ATTACHMENTS_PER_SEND),
  ])
  .transform((value) => (Array.isArray(value) ? value : [value]))

const MultipartComposeFieldsShape = {
  to: RecipientFormListSchema,
  cc: RecipientFormListSchema.optional(),
  bcc: RecipientFormListSchema.optional(),
  subject: SubjectSchema,
  body: PlainTextBodySchema.refine(
    (body) => body.trim().length > 0,
    'Message body must not be empty',
  ),
  format: z.enum(['plain', 'markdown']),
  attachments: MultipartAttachmentListSchema.optional(),
} as const

function validateMultipartLimits(
  message: {
    to: readonly string[]
    cc?: readonly string[] | undefined
    bcc?: readonly string[] | undefined
    attachments?: readonly File[] | undefined
  },
  context: z.RefinementCtx,
): void {
  const recipientCount = message.to.length + (message.cc?.length ?? 0) + (message.bcc?.length ?? 0)
  if (recipientCount > MAX_RECIPIENTS_PER_SEND) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: `A message may have at most ${MAX_RECIPIENTS_PER_SEND} recipients`,
    })
  }

  const attachmentBytes = (message.attachments ?? []).reduce((total, file) => total + file.size, 0)
  if (attachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['attachments'],
      message: `Attachments may total at most ${MAX_TOTAL_ATTACHMENT_BYTES} bytes`,
    })
  }
}

function validateRecipients(
  message: {
    to: readonly RecipientInput[]
    cc?: readonly RecipientInput[] | undefined
    bcc?: readonly RecipientInput[] | undefined
  },
  context: z.RefinementCtx,
): void {
  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])]

  if (recipients.length > MAX_RECIPIENTS_PER_SEND) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: `A message may have at most ${MAX_RECIPIENTS_PER_SEND} recipients`,
    })
  }

  const normalized = recipients.map((recipient) => recipient.address.trim().toLowerCase())
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'Recipients must be unique across To, CC, and BCC',
    })
  }
}

export const NewMessageRequestSchema = z
  .object({ mailboxId: MailboxIdSchema, ...ComposeFieldsShape })
  .strict()
  .superRefine(validateRecipients)
  .openapi('NewMessageRequest')
export type NewMessageRequest = z.infer<typeof NewMessageRequestSchema>

export const NewMessageFormSchema = z
  .object({ mailboxId: MailboxIdSchema, ...MultipartComposeFieldsShape })
  .strict()
  .superRefine(validateMultipartLimits)
  .openapi('NewMessageForm')
export type NewMessageForm = z.infer<typeof NewMessageFormSchema>

export const ReplyMessageBodySchema = z
  .object({
    ...ComposeFieldsShape,
    targetMessageId: MessageIdSchema.optional(),
  })
  .strict()
  .superRefine(validateRecipients)
  .openapi('ReplyMessageBody')
export type ReplyMessageBody = z.infer<typeof ReplyMessageBodySchema>

export const ReplyMessageFormSchema = z
  .object({
    ...MultipartComposeFieldsShape,
    targetMessageId: MessageIdSchema.optional(),
  })
  .strict()
  .superRefine(validateMultipartLimits)
  .openapi('ReplyMessageForm')
export type ReplyMessageForm = z.infer<typeof ReplyMessageFormSchema>

export const ReplyMessageRequestSchema = z
  .object({
    mailboxId: MailboxIdSchema,
    threadId: ThreadIdSchema,
    ...ComposeFieldsShape,
    targetMessageId: MessageIdSchema.optional(),
  })
  .strict()
  .superRefine(validateRecipients)
  .openapi('ReplyMessageRequest')
export type ReplyMessageRequest = z.infer<typeof ReplyMessageRequestSchema>

export const NewMessageCommandSchema = z
  .object({
    mode: z.literal('new'),
    message: NewMessageRequestSchema,
  })
  .strict()
export const ReplyMessageCommandSchema = z
  .object({
    mode: z.literal('reply'),
    message: ReplyMessageRequestSchema,
  })
  .strict()

export const SendCommandSchema = z.discriminatedUnion('mode', [
  NewMessageCommandSchema,
  ReplyMessageCommandSchema,
])
export type SendCommand = z.infer<typeof SendCommandSchema>

export const SendRequestHeadersSchema = z
  .object({
    'idempotency-key': IdempotencyKeySchema,
  })
  .openapi('SendRequestHeaders')

export const OUTBOUND_SEND_STATES = ['queued', 'sending', 'sent', 'failed', 'unknown'] as const
export const OutboundSendStateSchema = z.enum(OUTBOUND_SEND_STATES)
export type OutboundSendState = z.infer<typeof OutboundSendStateSchema>

export const SendResponseSchema = z
  .object({
    id: OutboundSendIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    state: OutboundSendStateSchema,
    threadId: ThreadIdSchema,
    messageId: MessageIdSchema.nullable(),
    acceptedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema.nullable(),
    safeErrorCode: z.string().min(1).max(128).nullable(),
    retryability: DeliveryRetryabilitySchema,
  })
  .strict()
  .superRefine((send, context) => {
    const expectedRetryability =
      send.state === 'queued'
        ? 'retryable'
        : send.state === 'sending' || send.state === 'unknown'
          ? 'manual_confirmation_required'
          : 'not_retryable'
    if (send.retryability !== expectedRetryability) {
      context.addIssue({
        code: 'custom',
        path: ['retryability'],
        message: 'Retryability must match the durable send state',
      })
    }
    const isFailure = send.state === 'failed' || send.state === 'unknown'
    if (isFailure !== (send.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['safeErrorCode'],
        message: 'Failed and unknown sends require one safe error code',
      })
    }
  })
  .openapi('SendResponse')
export type SendResponse = z.infer<typeof SendResponseSchema>
