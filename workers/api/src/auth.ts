import {
  OpaqueAuthTokenSchema,
  type ApiTokenScope,
  type Principal,
} from '@cloudflare-inbox/contracts'
import { decodeApiTokenScopes } from '@cloudflare-inbox/db'
import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'

import { ApiFault, requireConfiguredOrigin } from './http'
import type {
  ApiBindings,
  ApiDependencies,
  ApiEnv,
  AuthenticatedActor,
  InboxRepositoryPort,
} from './types'

export const MAGIC_LINK_LIFETIME_MS = 15 * 60 * 1_000
export const MAGIC_LINK_COOLDOWN_MS = 60 * 1_000
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000
export const SESSION_COOKIE_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1_000

const PRODUCTION_SESSION_COOKIE = '__Host-simple-inbox-session'
const DEVELOPMENT_SESSION_COOKIE = 'simple-inbox-development-session'
const ALL_SCOPES: ApiTokenScope[] = ['read', 'send', 'settings']

export type AuthenticationResult =
  | { actor: AuthenticatedActor; attempted: 'api_token' | 'session' }
  | {
      actor?: undefined
      attempted: 'api_token' | 'api_token_forbidden' | 'none' | 'session'
    }

export function sessionCookieName(environment: string): string {
  return environment === 'local' ? DEVELOPMENT_SESSION_COOKIE : PRODUCTION_SESSION_COOKIE
}

export function setSessionCookie(context: Context<ApiEnv>, token: string, expiresAt: number): void {
  const deployed = context.env.ENVIRONMENT !== 'local'
  setCookie(context, sessionCookieName(context.env.ENVIRONMENT), token, {
    expires: new Date(expiresAt),
    httpOnly: true,
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'Lax',
    secure: deployed,
  })
}

export function clearSessionCookie(context: Context<ApiEnv>): void {
  const deployed = context.env.ENVIRONMENT !== 'local'
  setCookie(context, sessionCookieName(context.env.ENVIRONMENT), '', {
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'Lax',
    secure: deployed,
  })
}

export async function authenticate(
  request: Request,
  env: ApiBindings,
  dependencies: ApiDependencies,
  requiredScope: ApiTokenScope,
): Promise<AuthenticationResult> {
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/u.exec(authorization)
    if (match === null) return { attempted: 'api_token' }
    const token = match[1]
    if (token === undefined || !OpaqueAuthTokenSchema.safeParse(token).success) {
      return { attempted: 'api_token' }
    }
    const pepper = requirePepper(env)
    const digest = await dependencies.digestToken(token, pepper)
    const repository = dependencies.authRepository(env)
    const now = dependencies.now()
    const principal = await repository.findApiToken(digest, requiredScope, now)
    if (principal === undefined) {
      for (const scope of ALL_SCOPES) {
        if (scope === requiredScope) continue
        if ((await repository.findApiToken(digest, scope, now)) !== undefined) {
          return { attempted: 'api_token_forbidden' }
        }
      }
      return { attempted: 'api_token' }
    }
    return {
      actor: {
        authKind: 'api_token',
        email: principal.email,
        scopes: decodeApiTokenScopes(principal.scopes),
        tokenDigest: digest,
        userId: principal.userId,
      },
      attempted: 'api_token',
    }
  }

  const token = readCookie(request.headers.get('cookie'), sessionCookieName(env.ENVIRONMENT))
  if (token === undefined) return { attempted: 'none' }
  if (!OpaqueAuthTokenSchema.safeParse(token).success) return { attempted: 'session' }

  const pepper = requirePepper(env)
  const digest = await dependencies.digestToken(token, pepper)
  const principal = await dependencies.authRepository(env).findSession(digest, dependencies.now())
  if (principal === undefined) return { attempted: 'session' }
  return {
    actor: {
      authKind: 'session',
      email: principal.email,
      scopes: ALL_SCOPES,
      sessionExpiresAt: principal.expiresAt,
      sessionId: principal.sessionId,
      tokenDigest: digest,
      userId: principal.userId,
    },
    attempted: 'session',
  }
}

export async function requireActor(
  request: Request,
  env: ApiBindings,
  dependencies: ApiDependencies,
  requiredScope: ApiTokenScope,
): Promise<AuthenticatedActor> {
  const result = await authenticate(request, env, dependencies, requiredScope)
  if (result.actor !== undefined) return result.actor
  if (result.attempted === 'api_token_forbidden') throw new ApiFault('forbidden')
  throw new ApiFault(result.attempted === 'session' ? 'session_expired' : 'unauthorized')
}

export function requireCookieMutationOrigin(
  request: Request,
  env: ApiBindings,
  actor: AuthenticatedActor,
): void {
  if (actor.authKind !== 'session') return

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') throw new ApiFault('csrf_rejected')
  if (
    fetchSite !== undefined &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'same-site' &&
    fetchSite !== 'none'
  ) {
    throw new ApiFault('csrf_rejected')
  }

  const trustedOrigin = requireConfiguredOrigin(env.APP_ORIGIN, env.ENVIRONMENT).origin
  const origin = request.headers.get('origin')
  if (origin !== null) {
    if (safeOrigin(origin) !== trustedOrigin) throw new ApiFault('csrf_rejected')
    return
  }

  const referer = request.headers.get('referer')
  if (referer === null || safeOrigin(referer) !== trustedOrigin) {
    throw new ApiFault('csrf_rejected')
  }
}

export async function principalForActor(
  actor: AuthenticatedActor,
  inbox: InboxRepositoryPort,
): Promise<Principal> {
  const mailboxes = await inbox.listMailboxes()
  return {
    email: actor.email as Principal['email'],
    mailboxes: mailboxes.map((mailbox) => ({
      mailboxId: mailbox.id as Principal['mailboxes'][number]['mailboxId'],
      role: requireMailboxRole(mailbox.role),
    })),
    userId: actor.userId as Principal['userId'],
  }
}

export function requirePepper(env: ApiBindings): string {
  const pepper = env.AUTH_TOKEN_PEPPER
  if (pepper === undefined || new TextEncoder().encode(pepper).byteLength < 32) {
    throw new ApiFault('service_unavailable')
  }
  return pepper
}

function requireMailboxRole(value: string): 'member' | 'owner' {
  if (value === 'member' || value === 'owner') return value
  throw new ApiFault('internal_error')
}

function readCookie(header: string | null, name: string): string | undefined {
  if (header === null) return undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}
