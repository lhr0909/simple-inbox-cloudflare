import { z } from '@hono/zod-openapi'
import { EmailAddressSchema, IsoDateTimeSchema } from './primitives'
import { MailDomainSchema } from './setup'

export const CreateSpamRuleSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('recipient'), value: EmailAddressSchema }).strict(),
    z.object({ kind: z.literal('sender'), value: EmailAddressSchema }).strict(),
    z
      .object({
        kind: z.literal('domain'),
        value: z.string().trim().toLowerCase().pipe(MailDomainSchema),
      })
      .strict(),
  ])
  .openapi('CreateSpamRule')
export type CreateSpamRule = z.infer<typeof CreateSpamRuleSchema>
export const SpamRulesResponseSchema = z
  .object({
    rules: z.array(
      z
        .object({
          id: z.string().uuid(),
          kind: z.enum(['recipient', 'sender', 'domain']),
          value: z.string(),
          createdAt: IsoDateTimeSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .openapi('SpamRulesResponse')
export type SpamRulesResponse = z.infer<typeof SpamRulesResponseSchema>
