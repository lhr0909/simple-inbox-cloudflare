import { IdempotencyKeySchema } from '@cloudflare-inbox/contracts'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { MailFault } from './errors'
import { handleMailError, privateNoStore, requireContentType } from './http'
import { requireInternalAuthorization } from './internal-auth'
import { logEvent } from './logging'
import { resolveRequestId } from './request-id'
import { captureInboundEmail } from './services/inbound'
import { D1MailStore } from './services/mail-store'
import { parseInboundMime } from './services/mime'
import {
  deliverMagicLink,
  parseInternalSendRequest,
  sendStatusResponse,
  submitInternalSend,
} from './services/outbound'
import { runRetention } from './services/retention'
import type { MailBindings, MailDependencies, MailEnv } from './types'
import { createReplyAliasToken, createUuidV7 } from './uuid-v7'

const SEND_BODY_LIMIT = 22 * 1_024 * 1_024
const JSON_BODY_LIMIT = 1 * 1_024 * 1_024

const defaultDependencies: MailDependencies = {
  createStore: (binding) => new D1MailStore(binding),
  generateAliasToken: createReplyAliasToken,
  generateId: createUuidV7,
  now: Date.now,
  parseMime: parseInboundMime,
}

export function resolveMailDependencies(
  overrides: Partial<MailDependencies> = {},
): MailDependencies {
  return { ...defaultDependencies, ...overrides }
}

export function createMailApp(overrides: Partial<MailDependencies> = {}) {
  const dependencies = resolveMailDependencies(overrides)
  const app = new Hono<MailEnv>()

  app.use('*', async (context, next) => {
    const requestId = resolveRequestId(context.req.raw)
    context.set('requestId', requestId)
    context.header('x-request-id', requestId)
    context.header('x-content-type-options', 'nosniff')
    context.header('referrer-policy', 'no-referrer')
    await next()
    context.res.headers.set('x-request-id', requestId)
    context.res.headers.set('x-content-type-options', 'nosniff')
    context.res.headers.set('referrer-policy', 'no-referrer')
    if (new URL(context.req.url).pathname.startsWith('/internal/')) privateNoStore(context.res)
  })

  app.use('/internal/v1/*', async (context, next) => {
    requireInternalAuthorization(context.req.raw, context.env.INTERNAL_REQUEST_SECRET)
    await next()
  })

  app.use(
    '/internal/v1/send',
    bodyLimit({
      maxSize: SEND_BODY_LIMIT,
      onError: () => {
        throw new MailFault('request_too_large', 413)
      },
    }),
  )
  app.use(
    '/internal/v1/auth/magic-link',
    bodyLimit({
      maxSize: JSON_BODY_LIMIT,
      onError: () => {
        throw new MailFault('request_too_large', 413)
      },
    }),
  )

  app.get('/internal/health', (context) =>
    context.json({ ok: true as const, service: 'mail' as const }),
  )

  app.post('/internal/v1/send', async (context) => {
    requireContentType(context.req.raw, 'multipart/form-data')
    let form: FormData
    try {
      form = await context.req.formData()
    } catch (error) {
      throw new MailFault('validation_failed', 400, { cause: error })
    }
    const result = await submitInternalSend(
      await parseInternalSendRequest(form),
      context.env,
      dependencies,
    )
    return context.json(result.response, result.status)
  })

  app.post('/internal/v1/auth/magic-link', async (context) => {
    requireContentType(context.req.raw, 'application/json')
    let input: unknown
    try {
      input = await context.req.json()
    } catch (error) {
      throw new MailFault('validation_failed', 400, { cause: error })
    }
    try {
      await deliverMagicLink(input, context.env)
    } catch (error) {
      if (error instanceof MailFault) throw error
      throw new MailFault('service_unavailable', 503, { cause: error })
    }
    return context.body(null, 202)
  })

  app.get('/internal/v1/sends/:idempotencyKey', async (context) => {
    const parsed = IdempotencyKeySchema.safeParse(context.req.param('idempotencyKey'))
    if (!parsed.success) throw new MailFault('validation_failed', 400)
    const record = await dependencies
      .createStore(context.env.DB)
      .findSendByIdempotencyKey(parsed.data)
    if (record === undefined) throw new MailFault('not_found', 404)
    return context.json(sendStatusResponse(record), 200)
  })

  app.notFound(() => {
    throw new MailFault('not_found', 404)
  })
  app.onError(handleMailError)
  return app
}

export async function receiveEmailWithDependencies(
  message: ForwardableEmailMessage,
  env: MailBindings,
  _context: ExecutionContext,
  overrides: Partial<MailDependencies> = {},
): Promise<void> {
  const requestId = crypto.randomUUID()
  await captureInboundEmail(message, env, resolveMailDependencies(overrides), requestId)
}

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: MailBindings,
  context: ExecutionContext,
): Promise<void> {
  await receiveEmailWithDependencies(message, env, context)
}

export async function scheduledRetention(
  controller: ScheduledController,
  env: MailBindings,
  _context: ExecutionContext,
): Promise<void> {
  const requestId = crypto.randomUUID()
  try {
    await runRetention(env, {
      generateRequestId: () => requestId,
      now: () => controller.scheduledTime,
    })
  } catch (error) {
    logEvent(
      'error',
      'mail.retention.failed',
      { environment: env.ENVIRONMENT, outcome: 'failed', requestId },
      { code: 'retention_run_failed' },
    )
    throw error
  }
}

export const app = createMailApp()
export type MailApp = typeof app
export type { MailBindings } from './types'

export default {
  email: receiveEmail,
  fetch: app.fetch,
  scheduled: scheduledRetention,
} satisfies ExportedHandler<MailBindings>
