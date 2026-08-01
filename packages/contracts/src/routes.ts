import { createRoute, z } from '@hono/zod-openapi'

import {
  AuthenticatedSessionResponseSchema,
  MagicLinkAcceptedResponseSchema,
  MagicLinkRequestSchema,
  MagicLinkVerifyRequestSchema,
  SessionResponseSchema,
} from './auth'
import { CapabilitiesResponseSchema } from './capabilities'
import { ErrorEnvelopeSchema } from './errors'
import {
  AttachmentIdSchema,
  IdempotencyKeySchema,
  MailboxIdSchema,
  MessageIdSchema,
  ThreadIdSchema,
} from './ids'
import {
  InternalHealthResponseSchema,
  InternalMagicLinkDeliverySchema,
  InternalSendFormSchema,
  InternalSendStatusResponseSchema,
} from './internal'
import {
  MailboxListResponseSchema,
  MailboxSettingsSchema,
  PatchMailboxRequestSchema,
} from './mailboxes'
import {
  NewMessageFormSchema,
  ReplyMessageFormSchema,
  SendRequestHeadersSchema,
  SendResponseSchema,
} from './send'
import { ThreadDetailResponseSchema, ThreadListResponseSchema } from './threads'
import { ThreadListQuerySchema } from './queries'

const json = (schema: z.ZodType) => ({
  content: { 'application/json': { schema } },
  description: 'JSON response',
})

const error = (description: string) => ({
  content: { 'application/json': { schema: ErrorEnvelopeSchema } },
  description,
})

const standardErrors = {
  400: error('The request was not valid.'),
  401: error('Authentication is required or expired.'),
  403: error('The operation is not allowed.'),
  404: error('The requested resource was absent or unauthorized.'),
  409: error('The request conflicts with existing state.'),
  413: error('The request body is too large.'),
  415: error('The request content type is not supported.'),
  429: error('The request was rate limited.'),
  500: error('An unexpected error occurred.'),
  502: error('The upstream mail provider failed or returned an unknown result.'),
  503: error('A required service is unavailable.'),
} as const

const MailboxPathSchema = z.object({
  mailboxId: MailboxIdSchema.openapi({
    param: { name: 'mailboxId', in: 'path' },
  }),
})

const ThreadPathSchema = z.object({
  threadId: ThreadIdSchema.openapi({
    param: { name: 'threadId', in: 'path' },
  }),
})

const MessagePathSchema = z.object({
  messageId: MessageIdSchema.openapi({
    param: { name: 'messageId', in: 'path' },
  }),
})

const AttachmentPathSchema = z.object({
  messageId: MessageIdSchema.openapi({
    param: { name: 'messageId', in: 'path' },
  }),
  attachmentId: AttachmentIdSchema.openapi({
    param: { name: 'attachmentId', in: 'path' },
  }),
})

const IdempotencyPathSchema = z.object({
  idempotencyKey: IdempotencyKeySchema.openapi({
    param: { name: 'idempotencyKey', in: 'path' },
  }),
})

const BinaryBodySchema = z.string().openapi({ format: 'binary' })

export const requestMagicLinkRoute = createRoute({
  method: 'post',
  path: '/v1/auth/magic-links',
  operationId: 'requestMagicLink',
  tags: ['Authentication'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: MagicLinkRequestSchema } },
    },
  },
  responses: {
    202: json(MagicLinkAcceptedResponseSchema),
    400: standardErrors[400],
    413: standardErrors[413],
    415: standardErrors[415],
    429: standardErrors[429],
    503: standardErrors[503],
  },
})

export const verifyMagicLinkRoute = createRoute({
  method: 'post',
  path: '/v1/auth/magic-links/verify',
  operationId: 'verifyMagicLink',
  tags: ['Authentication'],
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: MagicLinkVerifyRequestSchema } },
    },
  },
  responses: {
    200: json(AuthenticatedSessionResponseSchema),
    400: standardErrors[400],
    413: standardErrors[413],
    415: standardErrors[415],
    429: standardErrors[429],
    503: standardErrors[503],
  },
})

export const getSessionRoute = createRoute({
  method: 'get',
  path: '/v1/auth/session',
  operationId: 'getSession',
  tags: ['Authentication'],
  responses: {
    200: json(SessionResponseSchema),
    500: standardErrors[500],
    503: standardErrors[503],
  },
})

export const logoutRoute = createRoute({
  method: 'post',
  path: '/v1/auth/logout',
  operationId: 'logout',
  tags: ['Authentication'],
  responses: {
    204: { description: 'The session was revoked and the cookie was cleared.' },
    401: standardErrors[401],
    403: standardErrors[403],
  },
})

export const listMailboxesRoute = createRoute({
  method: 'get',
  path: '/v1/mailboxes',
  operationId: 'listMailboxes',
  tags: ['Mailboxes'],
  responses: {
    200: json(MailboxListResponseSchema),
    401: standardErrors[401],
    500: standardErrors[500],
    503: standardErrors[503],
  },
})

export const patchMailboxRoute = createRoute({
  method: 'patch',
  path: '/v1/mailboxes/{mailboxId}',
  operationId: 'patchMailbox',
  tags: ['Mailboxes'],
  request: {
    params: MailboxPathSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: PatchMailboxRequestSchema } },
    },
  },
  responses: {
    200: json(MailboxSettingsSchema),
    ...standardErrors,
  },
})

export const listThreadsRoute = createRoute({
  method: 'get',
  path: '/v1/threads',
  operationId: 'listThreads',
  tags: ['Threads'],
  request: { query: ThreadListQuerySchema },
  responses: {
    200: json(ThreadListResponseSchema),
    400: standardErrors[400],
    401: standardErrors[401],
    404: standardErrors[404],
    500: standardErrors[500],
  },
})

export const getThreadRoute = createRoute({
  method: 'get',
  path: '/v1/threads/{threadId}',
  operationId: 'getThread',
  tags: ['Threads'],
  request: { params: ThreadPathSchema },
  responses: {
    200: json(ThreadDetailResponseSchema),
    401: standardErrors[401],
    404: standardErrors[404],
    500: standardErrors[500],
  },
})

export const markThreadReadRoute = createRoute({
  method: 'post',
  path: '/v1/threads/{threadId}/read',
  operationId: 'markThreadRead',
  tags: ['Threads'],
  request: { params: ThreadPathSchema },
  responses: {
    204: { description: 'All inbound messages in the thread are marked read.' },
    401: standardErrors[401],
    403: standardErrors[403],
    404: standardErrors[404],
  },
})

export const archiveThreadRoute = createRoute({
  method: 'post',
  path: '/v1/threads/{threadId}/archive',
  operationId: 'archiveThread',
  tags: ['Threads'],
  request: { params: ThreadPathSchema },
  responses: {
    204: {
      description: 'The thread is archived without changing workflow state.',
    },
    401: standardErrors[401],
    403: standardErrors[403],
    404: standardErrors[404],
  },
})

export const unarchiveThreadRoute = createRoute({
  method: 'delete',
  path: '/v1/threads/{threadId}/archive',
  operationId: 'unarchiveThread',
  tags: ['Threads'],
  request: { params: ThreadPathSchema },
  responses: {
    204: {
      description: 'The thread is unarchived with its workflow state retained.',
    },
    401: standardErrors[401],
    403: standardErrors[403],
    404: standardErrors[404],
  },
})

export const sendNewMessageRoute = createRoute({
  method: 'post',
  path: '/v1/messages',
  operationId: 'sendNewMessage',
  tags: ['Messages'],
  request: {
    headers: SendRequestHeadersSchema,
    body: {
      required: true,
      content: { 'multipart/form-data': { schema: NewMessageFormSchema } },
    },
  },
  responses: {
    201: json(SendResponseSchema),
    202: json(SendResponseSchema),
    ...standardErrors,
  },
})

export const replyToThreadRoute = createRoute({
  method: 'post',
  path: '/v1/threads/{threadId}/messages',
  operationId: 'replyToThread',
  tags: ['Messages'],
  request: {
    params: ThreadPathSchema,
    headers: SendRequestHeadersSchema,
    body: {
      required: true,
      content: { 'multipart/form-data': { schema: ReplyMessageFormSchema } },
    },
  },
  responses: {
    201: json(SendResponseSchema),
    202: json(SendResponseSchema),
    ...standardErrors,
  },
})

export const downloadRawMessageRoute = createRoute({
  method: 'get',
  path: '/v1/messages/{messageId}/raw',
  operationId: 'downloadRawMessage',
  tags: ['Messages'],
  request: { params: MessagePathSchema },
  responses: {
    200: {
      content: { 'message/rfc822': { schema: BinaryBodySchema } },
      description: 'The immutable raw RFC 822 message.',
    },
    401: standardErrors[401],
    404: standardErrors[404],
    500: standardErrors[500],
  },
})

export const downloadAttachmentRoute = createRoute({
  method: 'get',
  path: '/v1/messages/{messageId}/attachments/{attachmentId}',
  operationId: 'downloadAttachment',
  tags: ['Messages'],
  request: { params: AttachmentPathSchema },
  responses: {
    200: {
      content: { 'application/octet-stream': { schema: BinaryBodySchema } },
      description: 'An authorized projection extracted from the raw message.',
    },
    401: standardErrors[401],
    404: standardErrors[404],
    500: standardErrors[500],
  },
})

export const getCapabilitiesRoute = createRoute({
  method: 'get',
  path: '/v1/capabilities',
  operationId: 'getCapabilities',
  tags: ['System'],
  responses: {
    200: json(CapabilitiesResponseSchema),
    500: standardErrors[500],
  },
})

export const OpenApiDocumentSchema = z
  .object({
    openapi: z.string(),
    info: z.object({ title: z.string(), version: z.string() }).passthrough(),
    paths: z.record(z.string(), z.unknown()),
  })
  .passthrough()

export const getOpenApiRoute = createRoute({
  method: 'get',
  path: '/v1/openapi.json',
  operationId: 'getOpenApiDocument',
  tags: ['System'],
  responses: { 200: json(OpenApiDocumentSchema) },
})

export const HealthResponseSchema = z
  .object({ ok: z.literal(true), service: z.literal('api') })
  .strict()
  .openapi('HealthResponse')

export const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  operationId: 'health',
  tags: ['System'],
  responses: { 200: json(HealthResponseSchema) },
})

export const internalSendRoute = createRoute({
  method: 'post',
  path: '/internal/v1/send',
  operationId: 'internalSend',
  tags: ['Internal'],
  request: {
    body: {
      required: true,
      content: { 'multipart/form-data': { schema: InternalSendFormSchema } },
    },
  },
  responses: {
    201: json(InternalSendStatusResponseSchema),
    202: json(InternalSendStatusResponseSchema),
    ...standardErrors,
  },
})

export const internalMagicLinkRoute = createRoute({
  method: 'post',
  path: '/internal/v1/auth/magic-link',
  operationId: 'internalMagicLink',
  tags: ['Internal'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: InternalMagicLinkDeliverySchema },
      },
    },
  },
  responses: {
    202: { description: 'The delivery was accepted.' },
    400: standardErrors[400],
    401: standardErrors[401],
    503: standardErrors[503],
  },
})

export const internalSendStatusRoute = createRoute({
  method: 'get',
  path: '/internal/v1/sends/{idempotencyKey}',
  operationId: 'internalSendStatus',
  tags: ['Internal'],
  request: { params: IdempotencyPathSchema },
  responses: {
    200: json(InternalSendStatusResponseSchema),
    401: standardErrors[401],
    404: standardErrors[404],
  },
})

export const internalHealthRoute = createRoute({
  method: 'get',
  path: '/internal/health',
  operationId: 'internalHealth',
  tags: ['Internal'],
  responses: { 200: json(InternalHealthResponseSchema) },
})

export const PUBLIC_API_ROUTES = [
  requestMagicLinkRoute,
  verifyMagicLinkRoute,
  getSessionRoute,
  logoutRoute,
  listMailboxesRoute,
  patchMailboxRoute,
  listThreadsRoute,
  getThreadRoute,
  markThreadReadRoute,
  archiveThreadRoute,
  unarchiveThreadRoute,
  sendNewMessageRoute,
  replyToThreadRoute,
  downloadRawMessageRoute,
  downloadAttachmentRoute,
  getCapabilitiesRoute,
  getOpenApiRoute,
  healthRoute,
] as const

export const INTERNAL_MAIL_ROUTES = [
  internalSendRoute,
  internalMagicLinkRoute,
  internalSendStatusRoute,
  internalHealthRoute,
] as const
