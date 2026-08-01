import { z } from '@hono/zod-openapi'

import { EmailAddressSchema } from './primitives'

export const SetupTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .openapi({ example: 'replace-with-a-random-one-time-setup-secret' })

export const MailDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => value === value.toLowerCase(), 'Expected a lower-case mail domain')
  .refine(isDomainName, 'Expected a valid mail domain')
  .openapi({ example: 'mail.example.test' })

export const CompleteSetupRequestSchema = z
  .object({
    applicationRecordRetentionDays: z.number().int().min(1).max(3_650),
    mailDomain: MailDomainSchema,
    mailboxAddress: EmailAddressSchema,
    ownerEmail: EmailAddressSchema,
    rawEmailRetentionDays: z.number().int().min(1).max(3_650),
    retentionBatchSize: z.number().int().min(1).max(100),
    setupToken: SetupTokenSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.rawEmailRetentionDays > input.applicationRecordRetentionDays) {
      context.addIssue({
        code: 'custom',
        message: 'Raw email retention cannot exceed inbox record retention.',
        path: ['rawEmailRetentionDays'],
      })
    }

    const separator = input.mailboxAddress.lastIndexOf('@')
    const mailboxDomain =
      separator < 0 ? '' : input.mailboxAddress.slice(separator + 1).toLowerCase()
    if (mailboxDomain !== input.mailDomain) {
      context.addIssue({
        code: 'custom',
        message: 'The inbox address must use the configured mail domain.',
        path: ['mailboxAddress'],
      })
    }
  })
  .openapi('CompleteSetupRequest')
export type CompleteSetupRequest = z.infer<typeof CompleteSetupRequestSchema>

export const SetupStatusResponseSchema = z
  .object({ status: z.enum(['required', 'complete']) })
  .strict()
  .openapi('SetupStatusResponse')
export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>

function isDomainName(value: string): boolean {
  if (value.endsWith('.') || value.includes('..')) return false
  const labels = value.split('.')
  return labels.every(
    (label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )
}
