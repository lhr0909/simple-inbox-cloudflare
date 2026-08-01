import { MAX_TOTAL_ATTACHMENT_BYTES, RequestIdSchema } from '@cloudflare-inbox/contracts'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'

import { ApiFault, errorResponse, logEvent, privateNoStore } from './http'
import { resolveRequestId } from './request-id'
import { registerAuthRoutes } from './routes/auth'
import { registerInboxRoutes } from './routes/inbox'
import { registerMessageRoutes } from './routes/messages'
import { registerSystemRoutes } from './routes/system'
import { resolveDependencies, type ApiDependencies, type ApiEnv } from './types'

const SMALL_BODY_LIMIT = 64 * 1_024
const SEND_BODY_LIMIT = MAX_TOTAL_ATTACHMENT_BYTES + 2 * 1_024 * 1_024

export function createApiApp(overrides: Partial<ApiDependencies> = {}) {
  const dependencies = resolveDependencies(overrides)
  const app = new OpenAPIHono<ApiEnv>({
    defaultHook: (result, context) => {
      if (result.success) return undefined
      const issues = result.error.issues.slice(0, 20).map((issue) => {
        const path = issue.path.length === 0 ? 'request' : issue.path.join('.')
        return `${path}: ${issue.message}`.slice(0, 512)
      })
      return errorResponse(context, 'validation_failed', {
        details: { issues },
      })
    },
  })

  app.use('*', async (context, next) => {
    const startedAt = Date.now()
    const requestId = RequestIdSchema.parse(resolveRequestId(context.req.raw))
    context.set('requestId', requestId)
    context.header('x-request-id', requestId)
    context.header('x-content-type-options', 'nosniff')
    context.header('referrer-policy', 'no-referrer')
    try {
      await next()
    } catch (error) {
      const status = error instanceof ApiFault ? error.status : 500
      logRequestCompletion(context, status, startedAt)
      throw error
    }
    context.res.headers.set('x-request-id', requestId)
    context.res.headers.set('x-content-type-options', 'nosniff')
    context.res.headers.set('referrer-policy', 'no-referrer')
    if (isPrivatePath(new URL(context.req.url).pathname)) privateNoStore(context.res)
    logRequestCompletion(context, context.res.status, startedAt)
  })

  app.use('*', async (context, next) => {
    const expected = expectedContentType(context.req.method, new URL(context.req.url).pathname)
    if (expected !== undefined && !hasContentType(context.req.header('content-type'), expected)) {
      return errorResponse(context, 'unsupported_media_type')
    }
    await next()
    return undefined
  })

  const smallLimit = bodyLimit({
    maxSize: SMALL_BODY_LIMIT,
    onError: (context) => errorResponse(context as Context<ApiEnv>, 'request_too_large'),
  })
  const sendLimit = bodyLimit({
    maxSize: SEND_BODY_LIMIT,
    onError: (context) => errorResponse(context as Context<ApiEnv>, 'request_too_large'),
  })
  app.use('/v1/auth/magic-links', smallLimit)
  app.use('/v1/auth/magic-links/verify', smallLimit)
  app.use('/v1/mailboxes/:mailboxId', smallLimit)
  app.use('/v1/messages', sendLimit)
  app.use('/v1/threads/:threadId/messages', sendLimit)

  registerAuthRoutes(app, dependencies)
  registerInboxRoutes(app, dependencies)
  registerMessageRoutes(app, dependencies)
  registerSystemRoutes(app)

  app.notFound((context) => errorResponse(context, 'not_found'))

  app.onError((error, context) => {
    const fault = error instanceof ApiFault ? error : new ApiFault('internal_error')
    logEvent(fault.status >= 500 ? 'error' : 'warn', 'api.request.failed', {
      code: fault.code,
      environment: context.env.ENVIRONMENT,
      method: context.req.method,
      outcome: 'failed',
      path: new URL(context.req.url).pathname,
      requestId: context.get('requestId'),
      status: fault.status,
    })
    return errorResponse(context, fault.code, {
      ...(fault.details === undefined ? {} : { details: fault.details }),
      status: fault.status,
    })
  })

  return app
}

function logRequestCompletion(context: Context<ApiEnv>, status: number, startedAt: number): void {
  const fields = {
    durationMs: Math.max(0, Date.now() - startedAt),
    environment: context.env.ENVIRONMENT,
    method: context.req.method,
    outcome: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success',
    path: new URL(context.req.url).pathname,
    requestId: context.get('requestId'),
    status,
  }
  if (status === 401 || status === 403) {
    logEvent('warn', 'api.authorization.denied', fields)
  }
  logEvent(
    status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    'api.request.completed',
    fields,
  )
}

function expectedContentType(
  method: string,
  path: string,
): 'application/json' | 'multipart/form-data' | undefined {
  if (
    method === 'POST' &&
    (path === '/v1/auth/magic-links' || path === '/v1/auth/magic-links/verify')
  ) {
    return 'application/json'
  }
  if (method === 'PATCH' && /^\/v1\/mailboxes\/[^/]+$/u.test(path)) {
    return 'application/json'
  }
  if (
    method === 'POST' &&
    (path === '/v1/messages' || /^\/v1\/threads\/[^/]+\/messages$/u.test(path))
  ) {
    return 'multipart/form-data'
  }
  return undefined
}

function hasContentType(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false
  const [mediaType, ...parameters] = header.split(';')
  if (mediaType?.trim().toLowerCase() !== expected) return false
  if (expected !== 'multipart/form-data') return true
  return parameters.some((parameter) => /^\s*boundary\s*=\s*.+$/iu.test(parameter))
}

function isPrivatePath(path: string): boolean {
  return /^\/v1\/(?:auth|mailboxes|messages|threads)(?:\/|$)/u.test(path)
}

export const app = createApiApp()
export type ApiApp = typeof app
export default app
