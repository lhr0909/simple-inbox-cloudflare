import type { ApiTokenScope, RequestId } from '@cloudflare-inbox/contracts'
import {
  AuthRepository,
  MailboxScopedRepository,
  digestOpaqueToken,
  generateOpaqueToken,
} from '@cloudflare-inbox/db'

import { createUuidV7 } from './uuid-v7'

export type ApiBindings = Omit<
  CloudflareBindings,
  'APP_ORIGIN' | 'ENVIRONMENT' | 'MAIL_DOMAIN' | 'OWNER_EMAIL' | 'RAW_EMAIL_RETENTION_DAYS'
> & {
  /** Secret binding. It is deliberately absent from committed Wrangler vars. */
  AUTH_TOKEN_PEPPER?: string
  APP_ORIGIN: string
  ENVIRONMENT: string
  MAIL_DOMAIN: string
  OWNER_EMAIL: string
  RAW_EMAIL_RETENTION_DAYS: string
}

export type ApiVariables = {
  requestId: RequestId
}

export type ApiEnv = {
  Bindings: ApiBindings
  Variables: ApiVariables
}

export type AuthKind = 'session' | 'api_token'

export interface AuthenticatedActor {
  authKind: AuthKind
  email: string
  scopes: ApiTokenScope[]
  sessionExpiresAt?: number
  sessionId?: string
  tokenDigest?: string
  userId: string
}

export interface SessionPrincipalRecord {
  email: string
  expiresAt: number
  sessionId: string
  userId: string
}

export interface ApiTokenPrincipalRecord {
  email: string
  scopes: number
  tokenId: string
  userId: string
}

export interface AuthRepositoryPort {
  tryCreateMagicLink(input: {
    cooldownMs: number
    expiresAt: number
    id: string
    normalizedEmail: string
    requestedAt: number
    tokenDigest: string
  }): Promise<boolean>
  consumeMagicLink(input: {
    consumedAt: number
    sessionExpiresAt: number
    sessionId: string
    sessionTokenDigest: string
    tokenDigest: string
  }): Promise<SessionPrincipalRecord | undefined>
  findSession(
    tokenDigest: string,
    now: number,
    lastSeenThrottleMs?: number,
  ): Promise<SessionPrincipalRecord | undefined>
  revokeSession(tokenDigest: string, revokedAt: number): Promise<boolean>
  findApiToken(
    tokenDigest: string,
    requiredScope: ApiTokenScope,
    now: number,
    lastUsedThrottleMs?: number,
  ): Promise<ApiTokenPrincipalRecord | undefined>
}

export type InboxRepositoryPort = Pick<
  MailboxScopedRepository,
  | 'getAttachment'
  | 'getMailboxSettings'
  | 'getRawMessage'
  | 'getThread'
  | 'getThreadDetail'
  | 'listMailboxes'
  | 'listThreads'
  | 'markThreadRead'
  | 'searchThreads'
  | 'setThreadArchived'
  | 'updateMailboxSettings'
>

export interface ApiDependencies {
  authRepository(env: ApiBindings): AuthRepositoryPort
  digestToken(token: string, pepper: string): Promise<string>
  generateId(now: number): string
  generateToken(): string
  inboxRepository(env: ApiBindings, userId: string): InboxRepositoryPort
  now(): number
}

const defaultDependencies: ApiDependencies = {
  authRepository: (env) => new AuthRepository(env.DB) as unknown as AuthRepositoryPort,
  digestToken: digestOpaqueToken,
  generateId: createUuidV7,
  generateToken: () => generateOpaqueToken(32).plaintext,
  inboxRepository: (env, userId) => new MailboxScopedRepository(env.DB, { userId }),
  now: Date.now,
}

export function resolveDependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return { ...defaultDependencies, ...overrides }
}
