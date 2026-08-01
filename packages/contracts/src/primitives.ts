import { z } from '@hono/zod-openapi'

export const IsoDateTimeSchema = z
  .string()
  .datetime()
  .openapi({ example: '2026-08-01T05:00:00.000Z' })
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

export const EmailAddressSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .email()
  .openapi({ example: 'owner@example.test' })
export type EmailAddress = z.infer<typeof EmailAddressSchema>

export const NormalizedEmailAddressSchema = EmailAddressSchema.refine(
  (address) => address === address.toLowerCase(),
  'Expected a lower-case normalized email address',
)
  .openapi({ example: 'owner@example.test' })
  .brand<'NormalizedEmailAddress'>()
export type NormalizedEmailAddress = z.infer<typeof NormalizedEmailAddressSchema>

export function normalizeEmailAddress(input: string): NormalizedEmailAddress {
  return NormalizedEmailAddressSchema.parse(input.trim().toLowerCase())
}

export const DisplayNameSchema = z.string().trim().min(1).max(256)

export const SubjectSchema = z.string().max(998).openapi({ example: 'Quarterly receipt' })

export const PreviewSchema = z.string().max(1_024)
export const PlainTextBodySchema = z.string().max(1_000_000)
export const HtmlBodySchema = z.string().max(2_000_000)

export const FileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isSafeFileName, 'Filename must not contain control or path separator characters')

export const MediaTypeSchema = z
  .string()
  .min(3)
  .max(255)
  .regex(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;.*)?$/,
    'Expected a MIME media type',
  )

export const Sha256HexSchema = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/, 'Expected a lower-case SHA-256 digest')
  .brand<'Sha256Hex'>()
export type Sha256Hex = z.infer<typeof Sha256HexSchema>

export const NonNegativeIntegerSchema = z.number().int().nonnegative()

export const EmptyResponseSchema = z.object({}).strict().openapi('EmptyResponse')

function isSafeFileName(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined ||
      codePoint < 32 ||
      codePoint === 127 ||
      character === '/' ||
      character === '\\'
    ) {
      return false
    }
  }
  return true
}
