import { env } from 'cloudflare:workers'

import { RequestIdSchema, makeErrorEnvelope } from '@cloudflare-inbox/contracts'
import { app as apiApp } from '@cloudflare-inbox/api'
import type { ApiBindings, InternalFetcher } from '@cloudflare-inbox/api'
import { InstallationRepository } from '@cloudflare-inbox/db'
import type { InstallationSettings, InstallationStatus } from '@cloudflare-inbox/db'
import { app as mailApp, receiveEmail, scheduledRetention } from '@cloudflare-inbox/mail'
import type { MailBindings } from '@cloudflare-inbox/mail'

const MAIL_INTERNAL_ORIGIN = 'https://mail.internal'
const UNCONFIGURED_API_PATHS = new Set([
  '/health',
  '/v1/capabilities',
  '/v1/openapi.json',
  '/v1/setup',
])

export type RootBindings = {
  AUTH_RATE_LIMIT: RateLimit
  /** Secret binding. It is deliberately absent from committed Wrangler vars. */
  AUTH_TOKEN_PEPPER?: string
  DB: D1Database
  EMAIL: SendEmail
  ENVIRONMENT: string
  RAW_EMAILS: R2Bucket
  /** One-time first-run secret. It is never persisted or returned. */
  SETUP_TOKEN?: string
}

export function rootBindings(): RootBindings {
  return env as unknown as RootBindings
}

export async function readInstallationStatus(
  bindings: RootBindings = rootBindings(),
): Promise<InstallationStatus> {
  return new InstallationRepository(bindings.DB).getStatus()
}

export async function fetchInternalApi(
  request: Request,
  bindings: RootBindings = rootBindings(),
): Promise<Response> {
  const status = await readInstallationStatus(bindings)
  const path = new URL(request.url).pathname
  if (status.status !== 'complete' && !UNCONFIGURED_API_PATHS.has(path)) {
    return unavailableResponse(request)
  }

  const apiBindings = createApiBindings(bindings, status)
  return apiApp.fetch(request, apiBindings)
}

export async function handleInboundEmail(
  message: ForwardableEmailMessage,
  bindings: RootBindings,
  context: ExecutionContext,
): Promise<void> {
  const status = await readInstallationStatus(bindings)
  if (status.status !== 'complete') {
    message.setReject('Simple Inbox setup is not complete.')
    return
  }
  await receiveEmail(message, createMailBindings(bindings, status.settings), context)
}

export async function handleScheduledRetention(
  controller: ScheduledController,
  bindings: RootBindings,
  context: ExecutionContext,
): Promise<void> {
  const status = await readInstallationStatus(bindings)
  if (status.status !== 'complete') return
  await scheduledRetention(controller, createMailBindings(bindings, status.settings), context)
}

function createApiBindings(bindings: RootBindings, status: InstallationStatus): ApiBindings {
  const settings = status.status === 'complete' ? status.settings : pendingSettings()
  const mailBindings =
    status.status === 'complete' ? createMailBindings(bindings, status.settings) : undefined
  return {
    AUTH_RATE_LIMIT: bindings.AUTH_RATE_LIMIT,
    ...(bindings.AUTH_TOKEN_PEPPER === undefined
      ? {}
      : { AUTH_TOKEN_PEPPER: bindings.AUTH_TOKEN_PEPPER }),
    APP_ORIGIN: settings.appOrigin,
    DB: bindings.DB,
    ENVIRONMENT: bindings.ENVIRONMENT,
    MAIL: createPrivateMailFetcher(mailBindings),
    MAIL_DOMAIN: settings.mailDomain,
    OWNER_EMAIL: settings.ownerEmail,
    RAW_EMAILS: bindings.RAW_EMAILS,
    RAW_EMAIL_RETENTION_DAYS: String(settings.rawEmailRetentionDays),
    ...(bindings.SETUP_TOKEN === undefined ? {} : { SETUP_TOKEN: bindings.SETUP_TOKEN }),
  }
}

function createMailBindings(bindings: RootBindings, settings: InstallationSettings): MailBindings {
  return {
    APPLICATION_RECORD_RETENTION_DAYS: String(settings.applicationRecordRetentionDays),
    APP_ORIGIN: settings.appOrigin,
    DB: bindings.DB,
    EMAIL: bindings.EMAIL,
    ENVIRONMENT: bindings.ENVIRONMENT,
    MAIL_DOMAIN: settings.mailDomain,
    OWNER_EMAIL: settings.ownerEmail,
    RAW_EMAILS: bindings.RAW_EMAILS,
    RAW_EMAIL_RETENTION_DAYS: String(settings.rawEmailRetentionDays),
    RETENTION_BATCH_SIZE: String(settings.retentionBatchSize),
  }
}

function createPrivateMailFetcher(mailBindings: MailBindings | undefined): InternalFetcher {
  return {
    async fetch(input, init) {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init)
      const url = new URL(request.url)
      if (
        mailBindings === undefined ||
        url.origin !== MAIL_INTERNAL_ORIGIN ||
        !url.pathname.startsWith('/internal/')
      ) {
        return new Response(null, {
          headers: { 'cache-control': 'private, no-store' },
          status: 404,
        })
      }
      return mailApp.fetch(request, mailBindings)
    },
  }
}

function pendingSettings(): InstallationSettings {
  return {
    applicationRecordRetentionDays: 90,
    appOrigin: 'https://setup.example.test',
    completedAt: 0,
    mailDomain: 'mail.example.test',
    mailboxAddress: 'inbox@mail.example.test',
    ownerEmail: 'owner@example.test',
    rawEmailRetentionDays: 30,
    retentionBatchSize: 100,
    setupVersion: 1,
  }
}

function unavailableResponse(request: Request): Response {
  const incomingId = request.headers.get('x-request-id')
  const parsedId = RequestIdSchema.safeParse(incomingId)
  const requestId = parsedId.success ? parsedId.data : RequestIdSchema.parse(crypto.randomUUID())
  return Response.json(makeErrorEnvelope('service_unavailable', requestId), {
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
    status: 503,
  })
}
