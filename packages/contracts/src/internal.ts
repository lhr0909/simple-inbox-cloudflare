import { z } from '@hono/zod-openapi'

import { ApiTokenScopeSchema, AuthKindSchema } from './auth'
import { IdempotencyKeySchema, MailboxIdSchema, RequestIdSchema, UserIdSchema } from './ids'
import {
  HtmlBodySchema,
  NormalizedEmailAddressSchema,
  PlainTextBodySchema,
  Sha256HexSchema,
  SubjectSchema,
} from './primitives'
import {
  MAX_TOTAL_ATTACHMENT_BYTES,
  MultipartAttachmentListSchema,
  NewMessageCommandSchema,
  ReplyMessageCommandSchema,
  SendResponseSchema,
} from './send'

export const InternalActorSchema = z
  .object({
    userId: UserIdSchema,
    mailboxId: MailboxIdSchema,
    authKind: AuthKindSchema,
    scopes: z.array(ApiTokenScopeSchema).max(3),
  })
  .strict()
  .openapi('InternalActor')
export type InternalActor = z.infer<typeof InternalActorSchema>

const InternalSendEnvelopeShape = {
  requestId: RequestIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  requestDigest: Sha256HexSchema,
  actor: InternalActorSchema,
} as const

export const MAX_INTERNAL_SEND_METADATA_CHARS = 6 * 1_024 * 1_024

export const InternalNewMessageRequestSchema = z
  .object({
    ...InternalSendEnvelopeShape,
    command: NewMessageCommandSchema,
  })
  .strict()
  .openapi('InternalNewMessageRequest')

export const InternalReplyMessageRequestSchema = z
  .object({
    ...InternalSendEnvelopeShape,
    command: ReplyMessageCommandSchema,
  })
  .strict()
  .openapi('InternalReplyMessageRequest')

export const InternalSendRequestSchema = z
  .union([InternalNewMessageRequestSchema, InternalReplyMessageRequestSchema])
  .superRefine((request, context) => {
    if (request.actor.mailboxId !== request.command.message.mailboxId) {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'mailboxId'],
        message: 'The actor mailbox must match the send command mailbox',
      })
    }
  })
  .openapi('InternalSendRequest')
export type InternalSendRequest = z.infer<typeof InternalSendRequestSchema>

export const InternalSendFormSchema = z
  .object({
    metadata: z.string().min(2).max(MAX_INTERNAL_SEND_METADATA_CHARS),
    attachments: MultipartAttachmentListSchema.optional(),
  })
  .strict()
  .superRefine((form, context) => {
    const request = safeParseInternalSendMetadata(form.metadata)
    if (request === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['metadata'],
        message: 'Internal send metadata is invalid',
      })
      return
    }

    const files = form.attachments ?? []
    const descriptors = request.command.message.attachments ?? []
    if (files.length !== descriptors.length) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: 'Attachment files must match the metadata descriptors',
      })
      return
    }

    const totalBytes = files.reduce((total, file) => total + file.size, 0)
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['attachments'],
        message: `Attachments may total at most ${MAX_TOTAL_ATTACHMENT_BYTES} bytes`,
      })
    }

    files.forEach((file, index) => {
      const descriptor = descriptors[index]
      if (
        descriptor === undefined ||
        descriptor.filename !== file.name ||
        descriptor.mediaType !== file.type ||
        descriptor.size !== file.size
      ) {
        context.addIssue({
          code: 'custom',
          path: ['attachments', index],
          message: 'Attachment metadata does not match the uploaded file',
        })
      }
    })
  })
  .openapi('InternalSendForm')
export type InternalSendForm = z.infer<typeof InternalSendFormSchema>

export function parseInternalSendForm(input: unknown): {
  attachments: File[]
  request: InternalSendRequest
} {
  const form = InternalSendFormSchema.parse(input)
  const request = InternalSendRequestSchema.parse(JSON.parse(form.metadata))
  return { attachments: form.attachments ?? [], request }
}

export const InternalMagicLinkDeliverySchema = z
  .object({
    requestId: RequestIdSchema,
    recipient: NormalizedEmailAddressSchema,
    subject: SubjectSchema,
    textBody: PlainTextBodySchema,
    htmlBody: HtmlBodySchema,
  })
  .strict()
  .openapi('InternalMagicLinkDelivery')
export type InternalMagicLinkDelivery = z.infer<typeof InternalMagicLinkDeliverySchema>

export const InternalSendStatusResponseSchema = SendResponseSchema

export const InternalHealthResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal('mail'),
  })
  .strict()
  .openapi('InternalHealthResponse')

function safeParseInternalSendMetadata(metadata: string): InternalSendRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(metadata)
    const result = InternalSendRequestSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}
