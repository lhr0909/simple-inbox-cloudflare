import {
  ApiTokenCreatedResponseSchema,
  ApiTokenListResponseSchema,
  listApiTokensRoute,
  createApiTokenRoute,
  revokeApiTokenRoute,
} from '@cloudflare-inbox/contracts'
import { ApiTokenRepository, type ApiTokenRecord } from '@cloudflare-inbox/db'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { requireActor, requireCookieMutationOrigin, requirePepper } from '../auth'
import { ApiFault } from '../http'
import type { ApiDependencies, ApiEnv } from '../types'

export function registerApiTokenRoutes(
  app: OpenAPIHono<ApiEnv>,
  dependencies: ApiDependencies,
): void {
  async function owner(request: Request, env: ApiEnv['Bindings']) {
    const actor = await requireActor(request, env, dependencies, 'read')
    // Bearer credentials cannot administer credentials, even with every scope.
    if (actor.authKind !== 'session' || actor.email !== env.OWNER_EMAIL)
      throw new ApiFault('forbidden')
    return actor
  }
  app.openapi(listApiTokensRoute, async (context) => {
    const actor = await owner(context.req.raw, context.env)
    const tokens = await new ApiTokenRepository(context.env.DB, actor.userId).list()
    return context.json(ApiTokenListResponseSchema.parse({ tokens: tokens.map(summary) }), 200)
  })
  app.openapi(createApiTokenRoute, async (context) => {
    const actor = await owner(context.req.raw, context.env)
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const input = context.req.valid('json')
    const now = dependencies.now()
    const expiresAt = input.expiresAt == null ? null : Date.parse(input.expiresAt)
    if (expiresAt !== null && expiresAt <= now) throw new ApiFault('validation_failed')
    if (input.mailboxIds !== null) {
      const mailboxes = await dependencies
        .inboxRepository(context.env, actor.userId)
        .listMailboxes()
      if (input.mailboxIds.some((id) => !mailboxes.some((mailbox) => mailbox.id === id)))
        throw new ApiFault('mailbox_not_found')
    }
    const token = dependencies.generateToken()
    const id = dependencies.generateId(now)
    await new ApiTokenRepository(context.env.DB, actor.userId).create({
      id,
      ...input,
      expiresAt,
      now,
      digest: await dependencies.digestToken(token, requirePepper(context.env)),
    })
    return context.json(
      ApiTokenCreatedResponseSchema.parse({
        token,
        apiToken: summary({
          id,
          ...input,
          expiresAt,
          createdAt: now,
          lastUsedAt: null,
          revokedAt: null,
        }),
      }),
      201,
    )
  })
  app.openapi(revokeApiTokenRoute, async (context) => {
    const actor = await owner(context.req.raw, context.env)
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    if (
      !(await new ApiTokenRepository(context.env.DB, actor.userId).revoke(
        context.req.valid('param').tokenId,
        dependencies.now(),
      ))
    )
      throw new ApiFault('not_found')
    return context.body(null, 204)
  })
}

function summary(record: ApiTokenRecord) {
  return {
    ...record,
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: record.expiresAt === null ? null : new Date(record.expiresAt).toISOString(),
    revokedAt: record.revokedAt === null ? null : new Date(record.revokedAt).toISOString(),
    lastUsedAt: record.lastUsedAt === null ? null : new Date(record.lastUsedAt).toISOString(),
  }
}
