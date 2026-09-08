import {
  InternalActorSchema,
  MAX_RECIPIENTS_PER_SEND,
  NewMessageRequestSchema,
  ReplyMessageRequestSchema,
  SendResponseSchema,
  downloadAttachmentRoute,
  downloadRawMessageRoute,
  getMessageHtmlRoute,
  replyToThreadRoute,
  sendNewMessageRoute,
  type RecipientInput,
  type IdempotencyKey,
  type SendResponse,
  type SendCommand,
} from '@cloudflare-inbox/contracts'
import {
  normalizeRecipientFields,
  parseAddressList,
  safeAttachmentContentType,
  sanitizeFilename,
} from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'

import { requireActor, requireCookieMutationOrigin } from '../auth'
import { ApiFault, logEvent } from '../http'
import { attachmentResponse, rawMessageResponse, messageHtmlPreview } from '../services/raw-email'
import { htmlPreviewResponse } from '../services/html-email'
import { submitSend } from '../services/mail-client'
import type { ApiDependencies, ApiEnv, AuthenticatedActor } from '../types'

export function registerMessageRoutes(
  app: OpenAPIHono<ApiEnv>,
  dependencies: ApiDependencies,
): void {
  app.openapi(sendNewMessageRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const form = context.req.valid('form')
    const attachments = form.attachments ?? []
    const parsedMessage = NewMessageRequestSchema.safeParse({
      attachments: attachmentDescriptors(attachments),
      body: form.body,
      cc: recipientInputs(form.cc),
      format: form.format,
      mailboxId: form.mailboxId,
      subject: form.subject,
      to: recipientInputs(form.to),
      bcc: recipientInputs(form.bcc),
    })
    if (!parsedMessage.success) throw new ApiFault('validation_failed')
    const message = parsedMessage.data
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    if ((await repository.getMailboxSettings(message.mailboxId)) === undefined) {
      throw new ApiFault('mailbox_not_found')
    }
    const result = await forwardSend(context, actor, attachments, {
      command: { message, mode: 'new' },
      idempotencyKey: context.req.valid('header')['idempotency-key'],
      mailboxId: message.mailboxId,
    })
    return result.status === 201 ? context.json(result.body, 201) : context.json(result.body, 202)
  })

  app.openapi(replyToThreadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const { threadId } = context.req.valid('param')
    const form = context.req.valid('form')
    const attachments = form.attachments ?? []
    const repository = dependencies.inboxRepository(context.env, actor.userId)
    const detail = await repository.getThreadDetail(threadId)
    if (detail === undefined) throw new ApiFault('thread_not_found')
    if (
      form.targetMessageId !== undefined &&
      !detail.messages.some(
        (message) => message.id === form.targetMessageId && message.direction === 'inbound',
      )
    ) {
      throw new ApiFault('message_not_found')
    }
    const parsedMessage = ReplyMessageRequestSchema.safeParse({
      attachments: attachmentDescriptors(attachments),
      bcc: recipientInputs(form.bcc),
      body: form.body,
      cc: recipientInputs(form.cc),
      format: form.format,
      mailboxId: detail.thread.mailboxId,
      subject: form.subject,
      targetMessageId: form.targetMessageId,
      threadId,
      to: recipientInputs(form.to),
    })
    if (!parsedMessage.success) throw new ApiFault('validation_failed')
    const message = parsedMessage.data
    const result = await forwardSend(context, actor, attachments, {
      command: { message, mode: 'reply' },
      idempotencyKey: context.req.valid('header')['idempotency-key'],
      mailboxId: detail.thread.mailboxId,
    })
    return result.status === 201 ? context.json(result.body, 201) : context.json(result.body, 202)
  })

  app.openapi(getMessageHtmlRoute, async (context) => {
    try {
      const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
      const { messageId } = context.req.valid('param')
      const repository = dependencies.inboxRepository(context.env, actor.userId)
      const metadata = await repository.getRawMessage(messageId)
      if (metadata === undefined) throw new ApiFault('message_not_found')
      const mailbox = await repository.getMailboxSettings(metadata.mailboxId)
      if (!mailbox?.renderHtml) throw new ApiFault('message_not_found')
      const preview = await messageHtmlPreview(context.env.RAW_EMAILS, metadata)
      return htmlPreviewResponse(preview.html)
    } catch (error) {
      return htmlPreviewResponse(null, error instanceof ApiFault ? error.status : 500)
    }
  })

  app.openapi(downloadRawMessageRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
    const metadata = await dependencies
      .inboxRepository(context.env, actor.userId)
      .getRawMessage(context.req.valid('param').messageId)
    if (metadata === undefined) throw new ApiFault('message_not_found')
    return rawMessageResponse(context.env.RAW_EMAILS, metadata, context.req.raw)
  })

  app.openapi(downloadAttachmentRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'read')
    const { attachmentId, messageId } = context.req.valid('param')
    const metadata = await dependencies
      .inboxRepository(context.env, actor.userId)
      .getAttachment(messageId, attachmentId)
    if (metadata === undefined) throw new ApiFault('attachment_not_found')
    return attachmentResponse(context.env.RAW_EMAILS, metadata, context.req.raw)
  })
}

async function forwardSend(
  context: Context<ApiEnv>,
  actor: AuthenticatedActor,
  attachments: readonly File[],
  input: { command: SendCommand; idempotencyKey: IdempotencyKey; mailboxId: string },
): Promise<{ body: SendResponse; status: 201 | 202 }> {
  const requestId = context.get('requestId')
  const internalActor = InternalActorSchema.parse({
    authKind: actor.authKind,
    mailboxId: input.mailboxId,
    scopes: actor.scopes,
    userId: actor.userId,
  })
  let response: Response
  try {
    response = await submitSend(context.env.MAIL, {
      actor: internalActor,
      attachments,
      command: input.command,
      idempotencyKey: input.idempotencyKey,
      requestId,
      signal: context.req.raw.signal,
    })
  } catch {
    logEvent('warn', 'api.send.unknown', {
      environment: context.env.ENVIRONMENT,
      outcome: 'unknown',
      requestId,
      userId: actor.userId,
    })
    throw new ApiFault('send_unknown')
  }

  if (response.status === 409) throw new ApiFault('idempotency_conflict')
  if (response.status === 413) throw new ApiFault('request_too_large')
  if (response.status === 429) throw new ApiFault('rate_limited')
  if (response.status === 503) throw new ApiFault('service_unavailable')
  if (response.status !== 201 && response.status !== 202) {
    throw new ApiFault(response.status >= 500 ? 'send_unknown' : 'send_failed')
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiFault('send_unknown')
  }
  const send = SendResponseSchema.safeParse(body)
  if (!send.success) throw new ApiFault('send_unknown')
  logEvent('info', 'api.send.accepted', {
    environment: context.env.ENVIRONMENT,
    outcome: 'accepted',
    outboundSendId: send.data.id,
    requestId,
    state: send.data.state,
    userId: actor.userId,
  })
  return { body: send.data, status: response.status }
}

function recipientInputs(values: readonly string[] | undefined): RecipientInput[] | undefined {
  if (values === undefined) return undefined
  if (values.length === 0) return []
  let parsed
  let normalized
  try {
    parsed = values.flatMap((value) => parseAddressList(value))
    normalized = normalizeRecipientFields({ to: values }, MAX_RECIPIENTS_PER_SEND)
  } catch {
    throw new ApiFault('validation_failed')
  }
  if (parsed.length !== normalized.count) throw new ApiFault('validation_failed')
  return parsed.map((recipient) => ({
    address: recipient.address as RecipientInput['address'],
    ...(recipient.name === undefined ? {} : { displayName: recipient.name }),
  }))
}

function attachmentDescriptors(attachments: readonly File[]) {
  return attachments.map((attachment) => ({
    filename: sanitizeFilename(attachment.name),
    mediaType: safeAttachmentContentType(attachment.type),
    size: attachment.size,
  }))
}
