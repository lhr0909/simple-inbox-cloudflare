import {
  RequestIdSchema,
  makeErrorEnvelope,
  type ApiErrorCode,
  type RequestId,
} from '@cloudflare-inbox/contracts'
import type { Context } from 'hono'

import { MailFault } from './errors'
import { logEvent } from './logging'
import type { MailEnv } from './types'

export function errorResponse(
  context: Context<MailEnv>,
  code: ApiErrorCode,
  status: number,
  details?: MailFault['details'],
): Response {
  const requestId = RequestIdSchema.parse(context.get('requestId')) as RequestId
  const envelope = makeErrorEnvelope(code, requestId, details === undefined ? {} : { details })
  return context.json(envelope, status as 400)
}

export function handleMailError(error: unknown, context: Context<MailEnv>): Response {
  const fault = error instanceof MailFault ? error : new MailFault('internal_error', 500)
  logEvent(
    fault.status >= 500 ? 'error' : 'warn',
    'mail.internal.failed',
    {
      environment: context.env.ENVIRONMENT,
      outcome: 'failed',
      requestId: context.get('requestId'),
    },
    {
      code: fault.code,
      method: context.req.method,
      path: new URL(context.req.url).pathname,
      status: fault.status,
    },
  )
  return errorResponse(context, fault.code, fault.status, fault.details)
}

export function privateNoStore(response: Response): void {
  response.headers.set('cache-control', 'private, no-store')
  response.headers.set('pragma', 'no-cache')
}

export function requireContentType(request: Request, expected: string): void {
  const header = request.headers.get('content-type')
  if (header === null) throw new MailFault('unsupported_media_type', 415)
  const [mediaType, ...parameters] = header.split(';')
  if (mediaType?.trim().toLowerCase() !== expected) {
    throw new MailFault('unsupported_media_type', 415)
  }
  if (
    expected === 'multipart/form-data' &&
    !parameters.some((parameter) => /^\s*boundary\s*=\s*.+$/iu.test(parameter))
  ) {
    throw new MailFault('unsupported_media_type', 415)
  }
}
