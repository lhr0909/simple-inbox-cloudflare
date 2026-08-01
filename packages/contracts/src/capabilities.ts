import { z } from '@hono/zod-openapi'

export const CapabilitiesResponseSchema = z
  .object({
    apiVersion: z.literal('v1'),
    publicApiTokens: z.boolean(),
    turnstile: z.boolean(),
    sanitizedHtml: z.boolean(),
    queues: z.boolean(),
    ai: z.boolean(),
  })
  .strict()
  .openapi('CapabilitiesResponse')
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>
