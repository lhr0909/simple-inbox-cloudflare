import {
  MailboxListResponseSchema,
  ThreadDetailResponseSchema,
  ThreadListResponseSchema,
  archiveThreadRoute,
  getThreadRoute,
  listMailboxesRoute,
  listThreadsRoute,
  markThreadReadRoute,
  patchThreadStateRoute,
  normalizeThreadListQuery,
  patchMailboxRoute,
  createMailboxRoute,
  unarchiveThreadRoute,
} from '@cloudflare-inbox/contracts'
import { AuthRepository } from '@cloudflare-inbox/db'
import { normalizeEmailAddress } from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'

import { requireActor, requireCookieMutationOrigin } from '../auth'
import { ApiFault } from '../http'
import {
  databaseFolder,
  projectMailboxSettings,
  projectMailboxSummary,
  projectThreadDetail,
  projectThreadSummary,
} from '../projections'
import type { ApiDependencies, ApiEnv } from '../types'

export function registerInboxRoutes(app: OpenAPIHono<ApiEnv>, dependencies: ApiDependencies): void {
  app.openapi(listMailboxesRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    const body = MailboxListResponseSchema.parse({
      mailboxes: (await repository.listMailboxes()).map(projectMailboxSummary),
    })
    return context.json(body, 200)
  })

  app.openapi(createMailboxRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    if (actor.email !== context.env.OWNER_EMAIL) throw new ApiFault('forbidden')
    const input = context.req.valid('json')
    const address = normalizeEmailAddress(input.address)
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    const known = await repository.listMailboxes()
    const domain = address.slice(address.lastIndexOf('@') + 1)
    if (
      domain !== context.env.MAIL_DOMAIN &&
      !known.some((m) => m.address.endsWith('@' + domain))
    ) {
      throw new ApiFault('validation_failed')
    }
    const now = dependencies.now()
    const result = await new AuthRepository(context.env.DB).bootstrapOwner({
      mailboxAddress: address,
      mailboxId: dependencies.generateId(now),
      now,
      ownerEmail: actor.email,
      userId: actor.userId,
      whitelisted: true,
    })
    await repository.updateMailboxSettings(
      result.mailboxId,
      {
        whitelisted: true,
        forwardTo: input.forward ? actor.email : null,
      },
      now,
    )
    const mailbox = await repository.getMailboxSettings(result.mailboxId)
    if (!mailbox) throw new ApiFault('mailbox_not_found')
    return context.json(projectMailboxSettings(mailbox), 200)
  })

  app.openapi(patchMailboxRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const { mailboxId } = context.req.valid('param')
    const patch = context.req.valid('json')
    let normalizedForwardTo: string | null | undefined
    try {
      normalizedForwardTo =
        patch.forwardTo === undefined || patch.forwardTo === null
          ? patch.forwardTo
          : normalizeEmailAddress(patch.forwardTo)
    } catch {
      throw new ApiFault('validation_failed')
    }
    const values = {
      ...(patch.whitelisted === undefined ? {} : { whitelisted: patch.whitelisted }),
      ...(patch.forwardHtml === undefined ? {} : { forwardHtml: patch.forwardHtml }),
      ...(patch.renderHtml === undefined ? {} : { renderHtml: patch.renderHtml }),
      ...(normalizedForwardTo === undefined ? {} : { forwardTo: normalizedForwardTo }),
      ...(patch.senderAlias === undefined ? {} : { senderAlias: patch.senderAlias }),
    }
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (!(await repository.updateMailboxSettings(mailboxId, values, dependencies.now()))) {
      throw new ApiFault('mailbox_not_found')
    }
    const mailbox = await repository.getMailboxSettings(mailboxId)
    if (mailbox === undefined) throw new ApiFault('mailbox_not_found')
    return context.json(projectMailboxSettings(mailbox), 200)
  })

  app.openapi(listThreadsRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
    const query = normalizeThreadListQuery(context.req.valid('query'))
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (
      query.mailboxId !== 'other' &&
      (await repository.getMailboxSettings(query.mailboxId)) === undefined
    ) {
      throw new ApiFault('mailbox_not_found')
    }
    const input = {
      folder: databaseFolder(query.folder),
      limit: query.limit,
      mailboxId: query.mailboxId,
      unreadOnly: query.unreadOnly,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    }
    const page =
      query.search === undefined
        ? await repository.listThreads(input)
        : await repository.searchThreads({ ...input, query: query.search })
    const body = ThreadListResponseSchema.parse({
      items: page.items.map(projectThreadSummary),
      nextCursor: page.nextCursor,
    })
    return context.json(body, 200)
  })

  app.openapi(getThreadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    const detail = await repository.getThreadDetail(context.req.valid('param').threadId)
    if (detail === undefined) throw new ApiFault('thread_not_found')
    const body = ThreadDetailResponseSchema.parse(projectThreadDetail(detail))
    return context.json(body, 200)
  })

  app.openapi(patchThreadStateRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (
      !(await repository.patchMessageState(
        context.req.valid('param').threadId,
        context.req.valid('json'),
        dependencies.now(),
      ))
    )
      throw new ApiFault('thread_not_found')
    return context.body(null, 204)
  })

  app.openapi(markThreadReadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (
      !(await repository.markThreadRead(context.req.valid('param').threadId, dependencies.now()))
    ) {
      throw new ApiFault('thread_not_found')
    }
    return context.body(null, 204)
  })

  app.openapi(archiveThreadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const now = dependencies.now()
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (!(await repository.setThreadArchived(context.req.valid('param').threadId, now, now))) {
      throw new ApiFault('thread_not_found')
    }
    return context.body(null, 204)
  })

  app.openapi(unarchiveThreadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'settings')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if (
      !(await repository.setThreadArchived(
        context.req.valid('param').threadId,
        null,
        dependencies.now(),
      ))
    ) {
      throw new ApiFault('thread_not_found')
    }
    return context.body(null, 204)
  })
}
