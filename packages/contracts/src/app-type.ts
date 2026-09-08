import type { Hono } from 'hono'

import type {
  AuthenticatedSessionResponse,
  MagicLinkAcceptedResponse,
  MagicLinkRequest,
  MagicLinkVerifyRequest,
  SessionResponse,
} from './auth'
import type { CapabilitiesResponse } from './capabilities'
import type { ErrorEnvelope } from './errors'
import type { AttachmentId, IdempotencyKey, MailboxId, MessageId, ThreadId } from './ids'
import type { MailboxListResponse, MailboxSettings, PatchMailboxRequest } from './mailboxes'
import type { ThreadListQuery } from './queries'
import type { NewMessageForm, ReplyMessageForm, SendResponse } from './send'
import type { CompleteSetupRequest, SetupStatusResponse } from './setup'
import type { ThreadDetailResponse, ThreadListResponse } from './threads'

type JsonEndpoint<Input, Output, Status extends number> = {
  input: Input
  output: Output
  outputFormat: 'json'
  status: Status
}

type EmptyEndpoint<Input, Status extends number> = {
  input: Input
  output: undefined
  outputFormat: 'text'
  status: Status
}

type BinaryEndpoint<Input, Status extends number> = {
  input: Input
  output: ArrayBuffer
  outputFormat: 'body'
  status: Status
}

type ErrorEndpoint<Input, Status extends number> = JsonEndpoint<Input, ErrorEnvelope, Status>
type StandardErrors<Input> =
  | ErrorEndpoint<Input, 400>
  | ErrorEndpoint<Input, 401>
  | ErrorEndpoint<Input, 403>
  | ErrorEndpoint<Input, 404>
  | ErrorEndpoint<Input, 409>
  | ErrorEndpoint<Input, 413>
  | ErrorEndpoint<Input, 415>
  | ErrorEndpoint<Input, 429>
  | ErrorEndpoint<Input, 500>
  | ErrorEndpoint<Input, 503>
type WithStandardErrors<Input, Success> = Success | StandardErrors<Input>

/**
 * Contract-only Hono schema for first-party `hc<AppType>()` consumers.
 *
 * The API module remains responsible for exporting the narrower `typeof app`
 * produced by its concrete chained handlers. This type keeps browser clients
 * decoupled from Worker bindings and Hono context types.
 */
export type PublicApiSchema = {
  '/v1/setup': {
    $get: WithStandardErrors<{}, JsonEndpoint<{}, SetupStatusResponse, 200>>
    $post: WithStandardErrors<
      { json: CompleteSetupRequest },
      JsonEndpoint<{ json: CompleteSetupRequest }, SetupStatusResponse, 200 | 201>
    >
  }
  '/v1/auth/magic-links': {
    $post: WithStandardErrors<
      { json: MagicLinkRequest },
      JsonEndpoint<{ json: MagicLinkRequest }, MagicLinkAcceptedResponse, 202>
    >
  }
  '/v1/auth/magic-links/verify': {
    $post: WithStandardErrors<
      { json: MagicLinkVerifyRequest },
      JsonEndpoint<{ json: MagicLinkVerifyRequest }, AuthenticatedSessionResponse, 200>
    >
  }
  '/v1/auth/session': {
    $get: WithStandardErrors<{}, JsonEndpoint<{}, SessionResponse, 200>>
  }
  '/v1/auth/logout': {
    $post: WithStandardErrors<{}, EmptyEndpoint<{}, 204>>
  }
  '/v1/mailboxes': {
    $get: WithStandardErrors<{}, JsonEndpoint<{}, MailboxListResponse, 200>>
  }
  '/v1/mailboxes/:mailboxId': {
    $patch: WithStandardErrors<
      { param: { mailboxId: MailboxId }; json: PatchMailboxRequest },
      JsonEndpoint<
        { param: { mailboxId: MailboxId }; json: PatchMailboxRequest },
        MailboxSettings,
        200
      >
    >
  }
  '/v1/threads': {
    $get: WithStandardErrors<
      { query: ThreadListQuery },
      JsonEndpoint<{ query: ThreadListQuery }, ThreadListResponse, 200>
    >
  }
  '/v1/threads/:threadId': {
    $get: WithStandardErrors<
      { param: { threadId: ThreadId } },
      JsonEndpoint<{ param: { threadId: ThreadId } }, ThreadDetailResponse, 200>
    >
  }
  '/v1/threads/:threadId/read': {
    $post: WithStandardErrors<
      { param: { threadId: ThreadId } },
      EmptyEndpoint<{ param: { threadId: ThreadId } }, 204>
    >
  }
  '/v1/threads/:threadId/archive': {
    $post: WithStandardErrors<
      { param: { threadId: ThreadId } },
      EmptyEndpoint<{ param: { threadId: ThreadId } }, 204>
    >
    $delete: WithStandardErrors<
      { param: { threadId: ThreadId } },
      EmptyEndpoint<{ param: { threadId: ThreadId } }, 204>
    >
  }
  '/v1/messages': {
    $post: WithStandardErrors<
      {
        header: { 'idempotency-key': IdempotencyKey }
        form: NewMessageForm
      },
      JsonEndpoint<
        {
          header: { 'idempotency-key': IdempotencyKey }
          form: NewMessageForm
        },
        SendResponse,
        201 | 202
      >
    >
  }
  '/v1/threads/:threadId/messages': {
    $post: WithStandardErrors<
      {
        param: { threadId: ThreadId }
        header: { 'idempotency-key': IdempotencyKey }
        form: ReplyMessageForm
      },
      JsonEndpoint<
        {
          param: { threadId: ThreadId }
          header: { 'idempotency-key': IdempotencyKey }
          form: ReplyMessageForm
        },
        SendResponse,
        201 | 202
      >
    >
  }
  '/v1/messages/:messageId/html': {
    $get: WithStandardErrors<
      { param: { messageId: MessageId } },
      BinaryEndpoint<{ param: { messageId: MessageId } }, 200>
    >
  }
  '/v1/messages/:messageId/raw': {
    $get: WithStandardErrors<
      { param: { messageId: MessageId } },
      BinaryEndpoint<{ param: { messageId: MessageId } }, 200>
    >
  }
  '/v1/messages/:messageId/attachments/:attachmentId': {
    $get: WithStandardErrors<
      { param: { messageId: MessageId; attachmentId: AttachmentId } },
      BinaryEndpoint<{ param: { messageId: MessageId; attachmentId: AttachmentId } }, 200>
    >
  }
  '/v1/capabilities': {
    $get: WithStandardErrors<{}, JsonEndpoint<{}, CapabilitiesResponse, 200>>
  }
  '/v1/openapi.json': {
    $get: JsonEndpoint<{}, Record<string, unknown>, 200>
  }
  '/health': {
    $get: JsonEndpoint<{}, { ok: true; service: 'api' }, 200>
  }
}

export type AppType = Hono<Record<never, never>, PublicApiSchema>
