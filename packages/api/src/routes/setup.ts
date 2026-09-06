import {
  SetupStatusResponseSchema,
  completeSetupRoute,
  getSetupStatusRoute,
} from '@cloudflare-inbox/contracts'
import { InstallationConflictError } from '@cloudflare-inbox/db'
import { normalizeEmailAddress } from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'

import { ApiFault, logEvent } from '../http'
import { allowedByRateLimiters, rateLimitKeyForSource } from '../rate-limit'
import type { ApiDependencies, ApiEnv } from '../types'

export function registerSetupRoutes(app: OpenAPIHono<ApiEnv>, dependencies: ApiDependencies): void {
  app.openapi(getSetupStatusRoute, async (context) => {
    const status = await dependencies.installationRepository(context.env).getStatus()
    if (status.status === 'inconsistent') throw new ApiFault('service_unavailable')
    return context.json(SetupStatusResponseSchema.parse({ status: status.status }), 200)
  })

  app.openapi(completeSetupRoute, async (context) => {
    const requestId = context.get('requestId')
    const appOrigin = requirePublicMutationOrigin(context.req.raw)
    const sourceKey = await rateLimitKeyForSource('setup:source', context.req.raw)
    if (!(await allowedByRateLimiters(context.env.AUTH_RATE_LIMIT, [sourceKey]))) {
      throw new ApiFault('rate_limited')
    }

    const input = context.req.valid('json')
    if (!(await validSetupToken(input.setupToken, context.env.SETUP_TOKEN))) {
      logEvent('warn', 'setup.authorization.denied', {
        environment: context.env.ENVIRONMENT,
        outcome: 'denied',
        requestId,
      })
      throw new ApiFault('forbidden')
    }

    const now = dependencies.now()
    try {
      const result = await dependencies.installationRepository(context.env).complete({
        applicationRecordRetentionDays: input.applicationRecordRetentionDays,
        appOrigin,
        completedAt: now,
        mailDomain: input.mailDomain,
        mailboxAddress: normalizeEmailAddress(input.mailboxAddress),
        mailboxId: dependencies.generateId(now),
        ownerEmail: normalizeEmailAddress(input.ownerEmail),
        rawEmailRetentionDays: input.rawEmailRetentionDays,
        retentionBatchSize: input.retentionBatchSize,
        userId: dependencies.generateId(now),
      })
      logEvent('info', 'setup.completed', {
        environment: context.env.ENVIRONMENT,
        outcome: result.created ? 'created' : 'already_complete',
        requestId,
      })
      const response = SetupStatusResponseSchema.parse({ status: 'complete' })
      return result.created ? context.json(response, 201) : context.json(response, 200)
    } catch (error) {
      if (error instanceof InstallationConflictError) throw new ApiFault('idempotency_conflict')
      throw error
    }
  })
}

async function validSetupToken(candidate: string, expected: string | undefined): Promise<boolean> {
  const encoder = new TextEncoder()
  if (expected === undefined || encoder.encode(expected).byteLength < 32) {
    throw new ApiFault('service_unavailable')
  }
  const [candidateDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const candidateBytes = new Uint8Array(candidateDigest)
  const expectedBytes = new Uint8Array(expectedDigest)
  let difference = candidateBytes.length ^ expectedBytes.length
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= (candidateBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0)
  }
  return difference === 0
}

function requirePublicMutationOrigin(request: Request): string {
  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    throw new ApiFault('csrf_rejected')
  }

  const host = request.headers.get('x-forwarded-host')
  const protocol = request.headers.get('x-forwarded-proto')
  if (host === null || protocol === null || !/^(?:http|https)$/u.test(protocol)) {
    throw new ApiFault('csrf_rejected')
  }

  let publicOrigin: string
  try {
    const url = new URL(`${protocol}://${host}`)
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new Error('Unsafe public origin.')
    }
    publicOrigin = url.origin
  } catch {
    throw new ApiFault('csrf_rejected')
  }

  const origin = request.headers.get('origin')
  try {
    if (origin === null || new URL(origin).origin !== publicOrigin)
      throw new Error('Origin mismatch.')
  } catch {
    throw new ApiFault('csrf_rejected')
  }
  return publicOrigin
}
