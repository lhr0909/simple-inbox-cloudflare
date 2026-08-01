import { z } from '@hono/zod-openapi'

import { type RequestId, RequestIdSchema } from './ids'

export const API_ERROR_CODES_V1 = [
  'validation_failed',
  'unsupported_media_type',
  'request_too_large',
  'unauthorized',
  'forbidden',
  'csrf_rejected',
  'rate_limited',
  'magic_link_invalid',
  'session_expired',
  'not_found',
  'mailbox_not_found',
  'thread_not_found',
  'message_not_found',
  'attachment_not_found',
  'idempotency_conflict',
  'send_failed',
  'send_unknown',
  'service_unavailable',
  'internal_error',
] as const

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES_V1)
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>

export const API_ERROR_MESSAGES_V1 = {
  validation_failed: 'The request was not valid.',
  unsupported_media_type: 'The request content type is not supported.',
  request_too_large: 'The request is too large.',
  unauthorized: 'Authentication is required.',
  forbidden: 'The requested operation is not allowed.',
  csrf_rejected: 'The request origin could not be verified.',
  rate_limited: 'Too many requests were received.',
  magic_link_invalid: 'The sign-in link is invalid or has expired.',
  session_expired: 'The session is invalid or has expired.',
  not_found: 'The requested resource could not be found.',
  mailbox_not_found: 'The mailbox could not be found.',
  thread_not_found: 'The thread could not be found.',
  message_not_found: 'The message could not be found.',
  attachment_not_found: 'The attachment could not be found.',
  idempotency_conflict: 'The idempotency key was already used for another request.',
  send_failed: 'The message could not be sent.',
  send_unknown: 'The final send result is not known yet.',
  service_unavailable: 'The service is temporarily unavailable.',
  internal_error: 'An unexpected error occurred.',
} as const satisfies Record<ApiErrorCode, string>

const ErrorDetailScalarSchema = z.union([
  z.string().max(1_024),
  z.number().finite(),
  z.boolean(),
  z.null(),
])

export const ErrorDetailsSchema = z
  .record(
    z.string().min(1).max(128),
    z.union([ErrorDetailScalarSchema, z.array(ErrorDetailScalarSchema).max(100)]),
  )
  .openapi('ErrorDetails')
export type ErrorDetails = z.infer<typeof ErrorDetailsSchema>

export const ApiErrorSchema = z
  .object({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(512),
    requestId: RequestIdSchema,
    details: ErrorDetailsSchema.optional(),
  })
  .strict()
  .openapi('ApiError')
export type ApiError = z.infer<typeof ApiErrorSchema>

export const ErrorEnvelopeSchema = z
  .object({ error: ApiErrorSchema })
  .strict()
  .openapi('ErrorEnvelope')
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>

export function makeErrorEnvelope(
  code: ApiErrorCode,
  requestId: RequestId,
  options: { message?: string; details?: ErrorDetails } = {},
): ErrorEnvelope {
  const message = options.message ?? API_ERROR_MESSAGES_V1[code]

  const envelope =
    options.details === undefined
      ? { error: { code, message, requestId } }
      : { error: { code, message, requestId, details: options.details } }

  return ErrorEnvelopeSchema.parse(envelope)
}

export const ERROR_HTTP_STATUS_V1 = {
  validation_failed: 400,
  unsupported_media_type: 415,
  request_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  csrf_rejected: 403,
  rate_limited: 429,
  magic_link_invalid: 400,
  session_expired: 401,
  not_found: 404,
  mailbox_not_found: 404,
  thread_not_found: 404,
  message_not_found: 404,
  attachment_not_found: 404,
  idempotency_conflict: 409,
  send_failed: 502,
  send_unknown: 502,
  service_unavailable: 503,
  internal_error: 500,
} as const satisfies Record<ApiErrorCode, number>
