import { z } from '@hono/zod-openapi'

import { ThreadFolderCountsSchema } from './folders'
import { MailboxIdSchema } from './ids'
import { EmailAddressSchema, IsoDateTimeSchema, NormalizedEmailAddressSchema } from './primitives'

export const SenderAliasSchema = z.string().trim().min(1).max(200)

export const MailboxSummarySchema = z
  .object({
    id: MailboxIdSchema,
    address: NormalizedEmailAddressSchema,
    senderAlias: SenderAliasSchema.nullable(),
    forwardTo: NormalizedEmailAddressSchema.nullable(),
    forwardHtml: z.boolean(),
    renderHtml: z.boolean(),
    counts: ThreadFolderCountsSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .openapi('MailboxSummary')
export type MailboxSummary = z.infer<typeof MailboxSummarySchema>

export const MailboxListResponseSchema = z
  .object({ mailboxes: z.array(MailboxSummarySchema).max(1_000) })
  .strict()
  .openapi('MailboxListResponse')
export type MailboxListResponse = z.infer<typeof MailboxListResponseSchema>

export const MailboxSettingsSchema = z
  .object({
    id: MailboxIdSchema,
    address: NormalizedEmailAddressSchema,
    senderAlias: SenderAliasSchema.nullable(),
    forwardTo: NormalizedEmailAddressSchema.nullable(),
    forwardHtml: z.boolean(),
    renderHtml: z.boolean(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .openapi('MailboxSettings')
export type MailboxSettings = z.infer<typeof MailboxSettingsSchema>

export const PatchMailboxRequestSchema = z
  .object({
    senderAlias: SenderAliasSchema.nullable().optional(),
    forwardTo: EmailAddressSchema.nullable().optional(),
    forwardHtml: z.boolean().optional(),
    renderHtml: z.boolean().optional(),
  })
  .strict()
  .refine(
    (request) => Object.values(request).some((value) => value !== undefined),
    'At least one mailbox setting must be provided',
  )
  .openapi('PatchMailboxRequest')
export type PatchMailboxRequest = z.infer<typeof PatchMailboxRequestSchema>
