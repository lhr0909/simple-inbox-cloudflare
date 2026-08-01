import {
  AuthenticatedSessionResponseSchema,
  type InternalMagicLinkDelivery,
  getSessionRoute,
  logoutRoute,
  requestMagicLinkRoute,
  verifyMagicLinkRoute,
} from '@cloudflare-inbox/contracts'
import { normalizeEmailAddress, sha256Hex } from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'

import {
  MAGIC_LINK_COOLDOWN_MS,
  MAGIC_LINK_LIFETIME_MS,
  SESSION_LIFETIME_MS,
  authenticate,
  clearSessionCookie,
  principalForActor,
  requireCookieMutationOrigin,
  requirePepper,
  setSessionCookie,
} from '../auth'
import { ApiFault, logEvent, requireConfiguredOrigin } from '../http'
import { deliverMagicLink } from '../services/mail-client'
import type { ApiDependencies, ApiEnv, AuthenticatedActor } from '../types'

export function registerAuthRoutes(app: OpenAPIHono<ApiEnv>, dependencies: ApiDependencies): void {
  app.openapi(requestMagicLinkRoute, async (context) => {
    const requestId = context.get('requestId')
    logEvent('info', 'auth.magic_link.requested', {
      environment: context.env.ENVIRONMENT,
      outcome: 'received',
      requestId,
    })
    try {
      const { email } = context.req.valid('json')
      const normalizedEmail = normalizeEmailAddress(email)
      const pepper = requirePepper(context.env)
      const appOrigin = requireConfiguredOrigin(context.env.APP_ORIGIN, context.env.ENVIRONMENT)
      const accountKey = `magic-request:account:${(await sha256Hex(normalizedEmail)).slice(0, 40)}`
      const sourceKey = await rateLimitKeyForSource('magic-request:source', context.req.raw)
      if (!(await allowedByRateLimiters(context.env.AUTH_RATE_LIMIT, [accountKey, sourceKey]))) {
        logEvent('warn', 'auth.magic_link.suppressed', {
          environment: context.env.ENVIRONMENT,
          outcome: 'suppressed',
          reason: 'coarse_rate_limit',
          requestId,
        })
        return context.json({ status: 'accepted' as const }, 202)
      }

      const now = dependencies.now()
      const plaintextToken = dependencies.generateToken()
      const tokenDigest = await dependencies.digestToken(plaintextToken, pepper)
      const created = await dependencies.authRepository(context.env).tryCreateMagicLink({
        cooldownMs: MAGIC_LINK_COOLDOWN_MS,
        expiresAt: now + MAGIC_LINK_LIFETIME_MS,
        id: dependencies.generateId(now),
        normalizedEmail,
        requestedAt: now,
        tokenDigest,
      })
      if (!created) {
        logEvent('info', 'auth.magic_link.suppressed', {
          environment: context.env.ENVIRONMENT,
          outcome: 'suppressed',
          reason: 'unknown_or_cooldown',
          requestId,
        })
        return context.json({ status: 'accepted' as const }, 202)
      }

      const verificationUrl = new URL('/auth/verify', appOrigin)
      verificationUrl.searchParams.set('token', plaintextToken)
      const response = await deliverMagicLink(
        context.env.MAIL,
        {
          htmlBody: `<p>Use this one-time link to sign in:</p><p><a href="${escapeHtml(verificationUrl.href)}">Sign in to Cloudflare Inbox</a></p><p>This link expires in 15 minutes.</p>`,
          recipient: normalizedEmail as InternalMagicLinkDelivery['recipient'],
          requestId,
          subject: 'Sign in to Cloudflare Inbox',
          textBody: `Use this one-time link to sign in:\n\n${verificationUrl.href}\n\nThis link expires in 15 minutes.`,
        },
        context.req.raw.signal,
      )
      logEvent(response.ok ? 'info' : 'warn', 'auth.magic_link.delivery', {
        accepted: response.ok,
        environment: context.env.ENVIRONMENT,
        outcome: response.ok ? 'accepted' : 'failed',
        requestId,
        status: response.status,
      })
    } catch {
      // Enumeration resistance includes missing bindings/secrets and delivery
      // failures: callers always receive the same accepted representation.
      logEvent('warn', 'auth.magic_link.suppressed', {
        environment: context.env.ENVIRONMENT,
        outcome: 'suppressed',
        reason: 'unavailable',
        requestId,
      })
    }
    return context.json({ status: 'accepted' as const }, 202)
  })

  app.openapi(verifyMagicLinkRoute, async (context) => {
    const requestId = context.get('requestId')
    const { token } = context.req.valid('json')
    const sourceKey = await rateLimitKeyForSource('magic-verify:source', context.req.raw)
    if (!(await allowedByRateLimiters(context.env.AUTH_RATE_LIMIT, [sourceKey]))) {
      throw new ApiFault('rate_limited')
    }

    const pepper = requirePepper(context.env)
    const now = dependencies.now()
    const tokenDigest = await dependencies.digestToken(token, pepper)
    const sessionToken = dependencies.generateToken()
    const sessionTokenDigest = await dependencies.digestToken(sessionToken, pepper)
    const sessionId = dependencies.generateId(now)
    const principal = await dependencies.authRepository(context.env).consumeMagicLink({
      consumedAt: now,
      sessionExpiresAt: now + SESSION_LIFETIME_MS,
      sessionId,
      sessionTokenDigest,
      tokenDigest,
    })
    if (principal === undefined) throw new ApiFault('magic_link_invalid')

    const actor: AuthenticatedActor = {
      authKind: 'session',
      email: principal.email,
      scopes: ['read', 'send', 'settings'],
      sessionExpiresAt: principal.expiresAt,
      sessionId: principal.sessionId,
      tokenDigest: sessionTokenDigest,
      userId: principal.userId,
    }
    const inbox = dependencies.inboxRepository(context.env, actor.userId)
    const body = AuthenticatedSessionResponseSchema.parse({
      authenticated: true,
      principal: await principalForActor(actor, inbox),
      session: {
        expiresAt: new Date(principal.expiresAt).toISOString(),
        id: principal.sessionId,
      },
    })
    setSessionCookie(context, sessionToken, principal.expiresAt)
    logEvent('info', 'auth.magic_link.consumed', {
      environment: context.env.ENVIRONMENT,
      outcome: 'authenticated',
      requestId,
      sessionId: principal.sessionId,
      userId: principal.userId,
    })
    return context.json(body, 200)
  })

  app.openapi(getSessionRoute, async (context) => {
    if (context.req.header('authorization') !== undefined) {
      return context.json({ authenticated: false as const }, 200)
    }
    const result = await authenticate(context.req.raw, context.env, dependencies, 'read')
    if (result.actor === undefined) {
      if (result.attempted === 'session') clearSessionCookie(context)
      return context.json({ authenticated: false as const }, 200)
    }
    const actor = result.actor
    if (
      actor.authKind !== 'session' ||
      actor.sessionId === undefined ||
      actor.sessionExpiresAt === undefined
    ) {
      return context.json({ authenticated: false as const }, 200)
    }
    const inbox = dependencies.inboxRepository(context.env, actor.userId)
    const body = AuthenticatedSessionResponseSchema.parse({
      authenticated: true,
      principal: await principalForActor(actor, inbox),
      session: {
        expiresAt: new Date(actor.sessionExpiresAt).toISOString(),
        id: actor.sessionId,
      },
    })
    return context.json(body, 200)
  })

  app.openapi(logoutRoute, async (context) => {
    const result = await authenticate(context.req.raw, context.env, dependencies, 'read')
    const actor = result.actor
    if (actor === undefined || actor.authKind !== 'session' || actor.tokenDigest === undefined) {
      throw new ApiFault(result.attempted === 'session' ? 'session_expired' : 'unauthorized')
    }
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    await dependencies
      .authRepository(context.env)
      .revokeSession(actor.tokenDigest, dependencies.now())
    clearSessionCookie(context)
    logEvent('info', 'auth.session.revoked', {
      environment: context.env.ENVIRONMENT,
      outcome: 'revoked',
      requestId: context.get('requestId'),
      sessionId: actor.sessionId,
      userId: actor.userId,
    })
    return context.body(null, 204)
  })
}

async function allowedByRateLimiters(
  binding: RateLimit,
  keys: readonly string[],
): Promise<boolean> {
  const results = await Promise.all(
    keys.map(async (key) => {
      try {
        return (await binding.limit({ key })).success
      } catch {
        return false
      }
    }),
  )
  return results.every(Boolean)
}

async function rateLimitKeyForSource(prefix: string, request: Request): Promise<string> {
  const source = trustedSourceNetwork(request)
  if (source === undefined) return `${prefix}:unavailable`
  return `${prefix}:${(await sha256Hex(source)).slice(0, 40)}`
}

/**
 * `CF-Connecting-IP` is authoritative only after a request has traversed the
 * Cloudflare edge. Requiring the runtime-only `request.cf` metadata prevents a
 * direct/local caller from turning a spoofed header into a fresh rate bucket.
 * IPv6 privacy addresses are grouped by /64 so changing the interface suffix
 * does not create a bucket per guessed token.
 */
function trustedSourceNetwork(request: Request): string | undefined {
  if (request.cf === undefined) return undefined

  const value = request.headers.get('cf-connecting-ip')?.trim()
  if (value === undefined || value.length === 0) return undefined

  const ipv4 = parseIpv4(value)
  if (ipv4 !== undefined) return ipv4.join('.')

  const ipv6 = parseIpv6(value)
  if (ipv6 === undefined) return undefined
  return `${ipv6
    .slice(0, 4)
    .map((part) => part.toString(16))
    .join(':')}::/64`
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined

  const octets = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return Number.NaN
    return Number(part)
  })
  return octets.every((octet) => Number.isInteger(octet) && octet <= 255) ? octets : undefined
}

function parseIpv6(value: string): number[] | undefined {
  if (!/^[0-9A-Fa-f:.]+$/u.test(value) || !value.includes(':')) return undefined

  let canonical = value
  if (canonical.includes('.')) {
    const separator = canonical.lastIndexOf(':')
    const ipv4 = separator < 0 ? undefined : parseIpv4(canonical.slice(separator + 1))
    if (ipv4 === undefined) return undefined
    canonical = `${canonical.slice(0, separator)}:${((ipv4[0] ?? 0) * 256 + (ipv4[1] ?? 0)).toString(16)}:${((ipv4[2] ?? 0) * 256 + (ipv4[3] ?? 0)).toString(16)}`
  }

  const compressed = canonical.split('::')
  if (compressed.length > 2) return undefined
  const left = parseIpv6Parts(compressed[0] ?? '')
  const right = parseIpv6Parts(compressed[1] ?? '')
  if (left === undefined || right === undefined) return undefined

  if (compressed.length === 1) return left.length === 8 ? left : undefined
  const missing = 8 - left.length - right.length
  if (missing < 1) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right]
}

function parseIpv6Parts(value: string): number[] | undefined {
  if (value.length === 0) return []
  const parts = value.split(':')
  if (parts.some((part) => !/^[0-9A-Fa-f]{1,4}$/u.test(part))) return undefined
  return parts.map((part) => Number.parseInt(part, 16))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
