import { z } from '@hono/zod-openapi'

import {
  ApiTokenIdSchema,
  MailboxIdSchema,
  OpaqueAuthTokenSchema,
  SessionIdSchema,
  UserIdSchema,
} from './ids'
import { EmailAddressSchema, IsoDateTimeSchema } from './primitives'

export const MagicLinkRequestSchema = z
  .object({ email: EmailAddressSchema })
  .strict()
  .openapi('MagicLinkRequest')
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>

export const MagicLinkAcceptedResponseSchema = z
  .object({ status: z.literal('accepted') })
  .strict()
  .openapi('MagicLinkAcceptedResponse')
export type MagicLinkAcceptedResponse = z.infer<typeof MagicLinkAcceptedResponseSchema>

export const MagicLinkVerifyRequestSchema = z
  .object({ token: OpaqueAuthTokenSchema })
  .strict()
  .openapi('MagicLinkVerifyRequest')
export type MagicLinkVerifyRequest = z.infer<typeof MagicLinkVerifyRequestSchema>

export const MailboxRoleSchema = z.enum(['owner', 'member'])
export type MailboxRole = z.infer<typeof MailboxRoleSchema>

export const PrincipalMailboxSchema = z
  .object({
    mailboxId: MailboxIdSchema,
    role: MailboxRoleSchema,
  })
  .strict()
  .openapi('PrincipalMailbox')

export const PrincipalSchema = z
  .object({
    userId: UserIdSchema,
    email: EmailAddressSchema,
    mailboxes: z.array(PrincipalMailboxSchema).max(1_000),
  })
  .strict()
  .openapi('Principal')
export type Principal = z.infer<typeof PrincipalSchema>

export const AuthenticatedSessionResponseSchema = z
  .object({
    authenticated: z.literal(true),
    principal: PrincipalSchema,
    session: z
      .object({
        id: SessionIdSchema,
        expiresAt: IsoDateTimeSchema,
      })
      .strict(),
  })
  .strict()
  .openapi('AuthenticatedSessionResponse')
export type AuthenticatedSessionResponse = z.infer<typeof AuthenticatedSessionResponseSchema>

export const AnonymousSessionResponseSchema = z
  .object({ authenticated: z.literal(false) })
  .strict()
  .openapi('AnonymousSessionResponse')
export type AnonymousSessionResponse = z.infer<typeof AnonymousSessionResponseSchema>

export const SessionResponseSchema = z
  .discriminatedUnion('authenticated', [
    AuthenticatedSessionResponseSchema,
    AnonymousSessionResponseSchema,
  ])
  .openapi('SessionResponse')
export type SessionResponse = z.infer<typeof SessionResponseSchema>

export const API_TOKEN_SCOPES = ['read', 'send', 'settings'] as const
export const ApiTokenScopeSchema = z.enum(API_TOKEN_SCOPES)
export type ApiTokenScope = z.infer<typeof ApiTokenScopeSchema>

const ApiTokenScopesSchema = z
  .array(ApiTokenScopeSchema)
  .min(1)
  .max(API_TOKEN_SCOPES.length)
  .superRefine((scopes, context) => {
    if (new Set(scopes).size !== scopes.length) {
      context.addIssue({
        code: 'custom',
        message: 'Token scopes must be unique',
      })
    }
  })

export const ApiTokenCreateRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: ApiTokenScopesSchema,
    expiresAt: IsoDateTimeSchema.nullable().optional(),
  })
  .strict()
  .openapi('ApiTokenCreateRequest')
export type ApiTokenCreateRequest = z.infer<typeof ApiTokenCreateRequestSchema>

export const ApiTokenSummarySchema = z
  .object({
    id: ApiTokenIdSchema,
    name: z.string().min(1).max(100),
    scopes: ApiTokenScopesSchema,
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
    revokedAt: IsoDateTimeSchema.nullable(),
    lastUsedAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .openapi('ApiTokenSummary')
export type ApiTokenSummary = z.infer<typeof ApiTokenSummarySchema>

export const ApiTokenCreatedResponseSchema = z
  .object({
    token: OpaqueAuthTokenSchema,
    apiToken: ApiTokenSummarySchema,
  })
  .strict()
  .openapi('ApiTokenCreatedResponse')
export type ApiTokenCreatedResponse = z.infer<typeof ApiTokenCreatedResponseSchema>

export const AuthKindSchema = z.enum(['session', 'api_token'])
export type AuthKind = z.infer<typeof AuthKindSchema>
