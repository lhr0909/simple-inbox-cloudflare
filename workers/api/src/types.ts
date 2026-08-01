import type { ApiTokenScope, RequestId } from '@cloudflare-inbox/contracts'
import {
  AuthRepository,
  InstallationRepository,
  MailboxScopedRepository,
  digestOpaqueToken,
  generateOpaqueToken,
} from '@cloudflare-inbox/db'
import type {
  CompleteInstallationInput,
  CompleteInstallationResult,
  InstallationStatus,
} from '@cloudflare-inbox/db'

import { createUuidV7 } from './uuid-v7'

export type ApiBindings = {
  AUTH_RATE_LIMIT: RateLimit
  /** Secret binding. It is deliberately absent from committed Wrangler vars. */
  AUTH_TOKEN_PEPPER?: string
  APP_ORIGIN: string
  DB: D1Database
  ENVIRONMENT: string
  MAIL: InternalFetcher
  MAIL_DOMAIN: string
  OWNER_EMAIL: string
  RAW_EMAILS: R2Bucket
  RAW_EMAIL_RETENTION_DAYS: string
  /** One-time first-run secret. It is never persisted or returned. */
  SETUP_TOKEN?: string
}

export interface InternalFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
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

export interface InstallationRepositoryPort {
  complete(input: CompleteInstallationInput): Promise<CompleteInstallationResult>
  getStatus(): Promise<InstallationStatus>
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
  installationRepository(env: ApiBindings): InstallationRepositoryPort
  now(): number
}

const defaultDependencies: ApiDependencies = {
  authRepository: (env) => new AuthRepository(env.DB) as unknown as AuthRepositoryPort,
  digestToken: digestOpaqueToken,
  generateId: createUuidV7,
  generateToken: () => generateOpaqueToken(32).plaintext,
  inboxRepository: (env, userId) => new MailboxScopedRepository(env.DB, { userId }),
  installationRepository: (env) => new InstallationRepository(env.DB),
  now: Date.now,
}

export function resolveDependencies(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return { ...defaultDependencies, ...overrides }
}
