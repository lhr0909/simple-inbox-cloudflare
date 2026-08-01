import { z } from '@hono/zod-openapi'

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const uuidV7 = (example: string) =>
  z.string().regex(UUID_V7_PATTERN, 'Expected a lower-case UUIDv7 identifier').openapi({ example })

export const UserIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-0123456789ab').brand<'UserId'>()
export type UserId = z.infer<typeof UserIdSchema>

export const MailboxIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-1123456789ab').brand<'MailboxId'>()
export type MailboxId = z.infer<typeof MailboxIdSchema>

export const ThreadIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-2123456789ab').brand<'ThreadId'>()
export type ThreadId = z.infer<typeof ThreadIdSchema>

export const MessageIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-3123456789ab').brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageIdSchema>

export const AttachmentIdSchema = uuidV7(
  '01996f7a-7bcd-7abc-8def-4123456789ab',
).brand<'AttachmentId'>()
export type AttachmentId = z.infer<typeof AttachmentIdSchema>

export const TagIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-5123456789ab').brand<'TagId'>()
export type TagId = z.infer<typeof TagIdSchema>

export const MagicLinkIdSchema = uuidV7(
  '01996f7a-7bcd-7abc-8def-6123456789ab',
).brand<'MagicLinkId'>()
export type MagicLinkId = z.infer<typeof MagicLinkIdSchema>

export const SessionIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-7123456789ab').brand<'SessionId'>()
export type SessionId = z.infer<typeof SessionIdSchema>

export const ApiTokenIdSchema = uuidV7('01996f7a-7bcd-7abc-8def-8123456789ab').brand<'ApiTokenId'>()
export type ApiTokenId = z.infer<typeof ApiTokenIdSchema>

export const OutboundSendIdSchema = uuidV7(
  '01996f7a-7bcd-7abc-8def-9123456789ab',
).brand<'OutboundSendId'>()
export type OutboundSendId = z.infer<typeof OutboundSendIdSchema>

export const ReplyAliasIdSchema = uuidV7(
  '01996f7a-7bcd-7abc-8def-a123456789ab',
).brand<'ReplyAliasId'>()
export type ReplyAliasId = z.infer<typeof ReplyAliasIdSchema>

export const RequestIdSchema = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque request identifier')
  .openapi({ example: '01JZXY8J6VSK8PKSRM3R7S3B2G' })
  .brand<'RequestId'>()
export type RequestId = z.infer<typeof RequestIdSchema>

export const CursorSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque base64url cursor')
  .openapi({ example: 'eyJ2IjoxLCJ0IjoxNzY3MjI1NjAwMDAwfQ' })
  .brand<'Cursor'>()
export type Cursor = z.infer<typeof CursorSchema>

export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, 'Use 16-128 URL-safe ASCII characters for an idempotency key')
  .openapi({ example: '01996f7a-7bcd-7abc-8def-b123456789ab' })
  .brand<'IdempotencyKey'>()
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>

export const OpaqueAuthTokenSchema = z
  .string()
  .min(43)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an unpadded base64url token')
  .openapi({ example: 'K3wnMJz4uVVYHF4eBgfRrtDXRskMJLR3zk4JP8Z_LjY' })
  .brand<'OpaqueAuthToken'>()
export type OpaqueAuthToken = z.infer<typeof OpaqueAuthTokenSchema>
