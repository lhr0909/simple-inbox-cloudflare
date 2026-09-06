import {
  ERROR_HTTP_STATUS_V1,
  type ApiErrorCode,
  type ErrorDetails,
  type RequestId,
  makeErrorEnvelope,
} from '@cloudflare-inbox/contracts'
import type { Context } from 'hono'

import type { ApiEnv } from './types'

export class ApiFault extends Error {
  readonly code: ApiErrorCode
  readonly details?: ErrorDetails
  readonly status: number

  constructor(code: ApiErrorCode, options: { details?: ErrorDetails; status?: number } = {}) {
    super(code)
    this.name = 'ApiFault'
    this.code = code
    this.status = options.status ?? ERROR_HTTP_STATUS_V1[code]
    if (options.details !== undefined) this.details = options.details
  }
}

export function errorResponse(
  context: Context<ApiEnv>,
  code: ApiErrorCode,
  options: { details?: ErrorDetails; status?: number } = {},
): Response {
  const status = options.status ?? ERROR_HTTP_STATUS_V1[code]
  const envelope = makeErrorEnvelope(code, context.get('requestId'), {
    ...(options.details === undefined ? {} : { details: options.details }),
  })
  return context.json(envelope, status as never)
}

export function requestId(context: Context<ApiEnv>): RequestId {
  return context.get('requestId')
}

export function isoDate(unixMilliseconds: number): string {
  const value = new Date(unixMilliseconds)
  if (!Number.isFinite(value.getTime())) throw new ApiFault('internal_error')
  return value.toISOString()
}

export function privateNoStore(response: Response): Response {
  response.headers.set('cache-control', 'private, no-store')
  response.headers.set('pragma', 'no-cache')
  return response
}

export function logEvent(
  level: 'info' | 'warn' | 'error',
  event: string,
  fields: Record<string, boolean | number | string | null | undefined>,
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, boolean | number | string | null] => {
      return entry[1] !== undefined
    }),
  )
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'api',
    ...safeFields,
    event,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export function requireConfiguredOrigin(rawOrigin: string, environment: string): URL {
  let origin: URL
  try {
    origin = new URL(rawOrigin)
  } catch {
    throw new ApiFault('service_unavailable')
  }
  const isLocal = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1'
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (environment === 'production' && origin.protocol !== 'https:') ||
    (origin.protocol !== 'https:' && !(environment !== 'production' && isLocal))
  ) {
    throw new ApiFault('service_unavailable')
  }
  return origin
}
