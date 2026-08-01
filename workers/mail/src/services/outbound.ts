import {
  InternalMagicLinkDeliverySchema,
  InternalSendRequestSchema,
  MAX_TOTAL_ATTACHMENT_BYTES,
  SendResponseSchema,
  type InternalMagicLinkDelivery,
  type InternalSendRequest,
  type RecipientInput,
  type SendResponse,
} from '@cloudflare-inbox/contracts'
import {
  appendReference,
  buildOutboundRawKey,
  checkProviderLimits,
  computeIdempotencyRequestDigest,
  ensureReplySubject,
  formatAddress,
  generateCanonicalOutboundEml,
  normalizeEmailAddress,
  normalizeMessageId,
  normalizeRecipientFields,
  normalizeSubject,
  normalizeSubjectForThreading,
  parseMailbox,
  renderSafeMessageContent,
  safeAttachmentContentType,
  sanitizeFilename,
  sha256Hex,
} from '@cloudflare-inbox/mail-core'
import {
  retryabilityForOutboundSendState,
  type InsertMessageProjectionInput,
} from '@cloudflare-inbox/db'

import { MailFault, safeProviderErrorCode } from '../errors'
import { logEvent } from '../logging'
import type {
  InternalSendResult,
  MailBindings,
  MailDependencies,
  MailboxRecord,
  PreparedInternalSend,
  ReplyContextMessage,
} from '../types'
import { putRawMessage } from './raw-email'

export async function parseInternalSendRequest(formData: FormData): Promise<PreparedInternalSend> {
  const metadata = formData.get('metadata')
  if (typeof metadata !== 'string' || metadata.length > 2_000_000) {
    throw new MailFault('validation_failed', 400)
  }
  let json: unknown
  try {
    json = JSON.parse(metadata)
  } catch (error) {
    throw new MailFault('validation_failed', 400, { cause: error })
  }
  const parsed = InternalSendRequestSchema.safeParse(json)
  if (!parsed.success) throw new MailFault('validation_failed', 400)
  const attachments = formData
    .getAll('attachments')
    .filter((entry): entry is File => typeof File !== 'undefined' && entry instanceof File)
  const descriptors = parsed.data.command.message.attachments ?? []
  if (attachments.length !== descriptors.length) throw new MailFault('validation_failed', 400)
  let totalBytes = 0
  for (const [index, attachment] of attachments.entries()) {
    const descriptor = descriptors[index]
    totalBytes += attachment.size
    if (
      descriptor === undefined ||
      attachment.name !== descriptor.filename ||
      attachment.size !== descriptor.size ||
      safeAttachmentContentType(attachment.type) !== safeAttachmentContentType(descriptor.mediaType)
    ) {
      throw new MailFault('validation_failed', 400)
    }
  }
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) throw new MailFault('request_too_large', 413)
  return { attachments, request: parsed.data }
}

export async function submitInternalSend(
  prepared: PreparedInternalSend,
  env: MailBindings,
  dependencies: MailDependencies,
): Promise<InternalSendResult> {
  const { attachments, request } = prepared
  if (!request.actor.scopes.includes('send')) throw new MailFault('forbidden', 403)
  await verifyRequestDigest(request, attachments)
  const store = dependencies.createStore(env.DB)
  const command = request.command
  const requestedThreadId = command.mode === 'reply' ? command.message.threadId : undefined
  const context = await store.getOutboundContext({
    actorUserId: request.actor.userId,
    mailboxId: request.actor.mailboxId,
    ...(requestedThreadId === undefined ? {} : { threadId: requestedThreadId }),
  })
  if (context === undefined) throw new MailFault('mailbox_not_found', 404)
  if (command.mode === 'reply' && context.thread === undefined) {
    throw new MailFault('thread_not_found', 404)
  }

  const now = dependencies.now()
  const selectedTarget =
    command.mode === 'reply'
      ? selectReplyTarget(context.messages, command.message.targetMessageId)
      : undefined
  if (
    command.mode === 'reply' &&
    (selectedTarget === undefined ||
      (command.message.targetMessageId !== undefined &&
        selectedTarget.id !== command.message.targetMessageId))
  ) {
    throw new MailFault('message_not_found', 404)
  }
  const subject =
    command.mode === 'reply'
      ? ensureReplySubject(command.message.subject)
      : normalizeSubject(command.message.subject)
  let recipients: ReturnType<typeof normalizeCommandRecipients>
  let rendered: ReturnType<typeof renderSafeMessageContent>
  let uploadedAttachments: Array<{ bytes: Uint8Array; filename: string; mediaType: string }>
  try {
    recipients = normalizeCommandRecipients(command.message)
    rendered =
      command.message.format === 'markdown'
        ? renderSafeMessageContent({ source: 'app', markdown: command.message.body })
        : renderSafeMessageContent({ source: 'app', text: command.message.body })
    uploadedAttachments = await Promise.all(
      attachments.map(async (file) => ({
        bytes: new Uint8Array(await file.arrayBuffer()),
        filename: sanitizeFilename(file.name),
        mediaType: safeAttachmentContentType(file.type),
      })),
    )
  } catch {
    throw new MailFault('validation_failed', 400)
  }
  const limits = checkProviderLimits('user-send', {
    attachments: uploadedAttachments.map((attachment) => ({
      contentType: attachment.mediaType,
      filename: attachment.filename,
      size: attachment.bytes.byteLength,
    })),
    html: rendered.html,
    recipientCount: recipients.to.length + recipients.cc.length + recipients.bcc.length,
    text: rendered.text,
  })
  if (!limits.allowed) {
    logEvent(
      'warn',
      'mail.outbound.rejected',
      { environment: env.ENVIRONMENT, outcome: 'rejected', requestId: request.requestId },
      { code: `provider_${limits.reasons[0] ?? 'limit'}` },
    )
    throw new MailFault('request_too_large', 413)
  }

  let proposedThreadId = context.thread?.id ?? dependencies.generateId(now)
  const newThread =
    context.thread === undefined
      ? {
          createdAt: now,
          id: proposedThreadId,
          lastMessageAt: now,
          mailboxId: context.mailbox.id,
          normalizedSubject: normalizeSubjectForThreading(command.message.subject),
          subject: normalizeSubject(command.message.subject),
          updatedAt: now,
          workflowState: 'waiting' as const,
        }
      : undefined

  const sendId = dependencies.generateId(now)
  const reservation = await store.reserveOutboundSend({
    actorUserId: request.actor.userId,
    createdAt: now,
    id: sendId,
    idempotencyKey: request.idempotencyKey,
    mailboxId: request.actor.mailboxId,
    ...(newThread === undefined ? {} : { newThread }),
    requestDigest: request.requestDigest,
    threadId: proposedThreadId,
  })
  if (reservation.kind === 'conflict') {
    throw new MailFault('idempotency_conflict', 409)
  }
  if (reservation.kind === 'replay' && reservation.send.state !== 'queued') {
    return responseForRecord(reservation.send)
  }
  if (reservation.kind === 'replay') {
    if (reservation.send.threadId === null) throw new MailFault('send_unknown', 502)
    proposedThreadId = reservation.send.threadId
  }

  const claimed = await store.claimQueuedSend({
    actorUserId: request.actor.userId,
    id: reservation.send.id,
    mailboxId: request.actor.mailboxId,
    now,
    requestDigest: request.requestDigest,
  })
  if (!claimed) {
    const current = await store.findSendByIdempotencyKey(request.idempotencyKey)
    if (current === undefined) throw new MailFault('send_unknown', 502)
    return responseForRecord(current)
  }

  const inReplyTo = messageIdentifier(selectedTarget)
  const references = appendReference(selectedTarget?.references, inReplyTo)
  let providerMessageId: string | null = null
  let safeErrorCode: string | null = null
  let state: 'sent' | 'unknown'
  logEvent(
    'info',
    'mail.outbound.started',
    { environment: env.ENVIRONMENT, outcome: 'started', requestId: request.requestId },
    { outboundSendId: reservation.send.id, source: 'api', threadId: proposedThreadId },
  )
  try {
    const headers = threadingHeaders(inReplyTo, references)
    const result = await env.EMAIL.send({
      attachments: uploadedAttachments.map((attachment) => ({
        content: attachment.bytes,
        disposition: 'attachment' as const,
        filename: attachment.filename,
        type: attachment.mediaType,
      })),
      ...(recipients.bcc.length === 0 ? {} : { bcc: providerAddresses(recipients.bcc) }),
      ...(recipients.cc.length === 0 ? {} : { cc: providerAddresses(recipients.cc) }),
      from: senderAddress(context.mailbox),
      ...(headers === undefined ? {} : { headers }),
      html: rendered.html,
      replyTo: context.mailbox.address,
      subject,
      text: rendered.text,
      to: providerAddresses(recipients.to),
    })
    providerMessageId = result.messageId
    state = 'sent'
  } catch (error) {
    state = 'unknown'
    safeErrorCode = safeProviderErrorCode(error, 'provider_send_unknown')
  }

  const messageId = dependencies.generateId(now)
  const canonicalProviderId = providerMessageId ?? `<${sendId}@${state}.invalid>`
  let rawKey: string
  let rawSha256: string
  let rawSize: number
  try {
    const canonical = generateCanonicalOutboundEml({
      attachments: uploadedAttachments.map((attachment) => ({
        content: attachment.bytes,
        contentType: attachment.mediaType,
        disposition: 'attachment',
        filename: attachment.filename,
      })),
      cc: recipients.cc.map((recipient) => formatAddress(recipient)),
      content: rendered,
      from: formatAddress(
        context.mailbox.senderAlias === null
          ? { address: context.mailbox.address }
          : { address: context.mailbox.address, name: context.mailbox.senderAlias },
      ),
      inReplyTo,
      providerMessageId: canonicalProviderId,
      references,
      sentAt: now,
      subject,
      to: recipients.to.map((recipient) => formatAddress(recipient)),
    })
    rawKey = buildOutboundRawKey(now, providerMessageId ?? sendId)
    const stored = await putRawMessage(env.RAW_EMAILS, rawKey, canonical, 'outbound')
    rawSha256 = stored.sha256
    rawSize = stored.size
  } catch (error) {
    const unknownCode = safeProviderErrorCode(error, 'outbound_record_unknown')
    await store.recordOutboundAttempt({
      actorUserId: request.actor.userId,
      id: reservation.send.id,
      mailboxId: request.actor.mailboxId,
      messageId: null,
      now: dependencies.now(),
      providerErrorCode: unknownCode,
      providerMessageId,
      requestDigest: request.requestDigest,
      state: 'unknown',
    })
    logEvent(
      'warn',
      'mail.outbound.unknown',
      { environment: env.ENVIRONMENT, outcome: 'unknown', requestId: request.requestId },
      { outboundSendId: reservation.send.id },
    )
    return responseForRecord({
      ...reservation.send,
      providerErrorCode: unknownCode,
      state: 'unknown',
      updatedAt: dependencies.now(),
    })
  }

  const projection: InsertMessageProjectionInput = {
    attachments: uploadedAttachments.map((attachment, mimeOrdinal) => ({
      contentId: null,
      createdAt: now,
      displayFilename: attachment.filename,
      disposition: 'attachment',
      id: dependencies.generateId(now),
      mediaType: attachment.mediaType,
      mimeOrdinal,
      size: attachment.bytes.byteLength,
    })),
    message: {
      createdAt: now,
      direction: 'outbound',
      forwardAttemptedAt: null,
      forwardState: 'not_applicable',
      fromAddress: context.mailbox.address,
      fromName: context.mailbox.senderAlias,
      htmlBody: rendered.html,
      htmlPolicy: 'sanitized',
      id: messageId,
      inReplyTo,
      ingestDigest: null,
      internetMessageId: normalizeMessageId(providerMessageId),
      mailboxId: context.mailbox.id,
      preview: previewText(rendered.text, subject),
      providerErrorCode: safeErrorCode,
      providerMessageId,
      rawR2Key: rawKey,
      rawSha256,
      rawSize,
      readAt: null,
      receivedAt: null,
      sendAttemptedAt: now,
      sendState: state,
      sentAt: now,
      subject,
      textBody: rendered.text,
      threadId: proposedThreadId,
      updatedAt: now,
    },
    recipients: [
      ...recipientProjection('to', recipients.to),
      ...recipientProjection('cc', recipients.cc),
      ...recipientProjection('bcc', recipients.bcc),
    ],
    references: references.map((internetMessageId, position) => ({
      internetMessageId,
      position,
    })),
  }
  const completedAt = dependencies.now()
  try {
    await store.completeOutboundProjection({
      actorUserId: request.actor.userId,
      now: completedAt,
      outboundSendId: reservation.send.id,
      projection,
      requestDigest: request.requestDigest,
    })
  } catch (error) {
    const code = safeProviderErrorCode(error, 'projection_after_send_unknown')
    const current = await store.findSendByIdempotencyKey(request.idempotencyKey)
    logEvent(
      'warn',
      'mail.outbound.unknown',
      { environment: env.ENVIRONMENT, outcome: 'unknown', requestId: request.requestId },
      { code, outboundSendId: reservation.send.id },
    )
    return responseForRecord(
      current ?? {
        ...reservation.send,
        state: 'sending',
        updatedAt: completedAt,
      },
    )
  }

  const record = {
    ...reservation.send,
    messageId,
    providerErrorCode: safeErrorCode,
    providerMessageId,
    state,
    threadId: proposedThreadId,
    updatedAt: completedAt,
  }
  logEvent(
    state === 'sent' ? 'info' : 'warn',
    `mail.outbound.${state}`,
    { environment: env.ENVIRONMENT, outcome: state, requestId: request.requestId },
    {
      messageId: record.messageId,
      outboundSendId: record.id,
      threadId: proposedThreadId,
    },
  )
  if (state === 'sent') {
    logEvent(
      'info',
      'mail.outbound.completed',
      { environment: env.ENVIRONMENT, outcome: 'completed', requestId: request.requestId },
      { messageId: record.messageId, outboundSendId: record.id, source: 'api', state },
    )
  }
  return responseForRecord(record)
}

export async function deliverMagicLink(input: unknown, env: MailBindings): Promise<void> {
  const delivery = InternalMagicLinkDeliverySchema.parse(input) as InternalMagicLinkDelivery
  const domain = parseMailbox(`auth@${env.MAIL_DOMAIN}`).domain
  const limits = checkProviderLimits('user-send', {
    html: delivery.htmlBody,
    recipientCount: 1,
    text: delivery.textBody,
  })
  if (!limits.allowed) throw new MailFault('send_failed', 502)
  await env.EMAIL.send({
    from: `no-reply@${domain}`,
    html: delivery.htmlBody,
    subject: delivery.subject,
    text: delivery.textBody,
    to: normalizeEmailAddress(delivery.recipient),
  })
}

export function sendStatusResponse(record: {
  createdAt: number
  id: string
  idempotencyKey: string
  messageId: string | null
  providerErrorCode: string | null
  state: 'failed' | 'queued' | 'sending' | 'sent' | 'unknown'
  threadId: string | null
  updatedAt: number
}): SendResponse {
  if (record.threadId === null) throw new MailFault('send_unknown', 502)
  return SendResponseSchema.parse({
    acceptedAt: new Date(record.createdAt).toISOString(),
    completedAt:
      record.state === 'sent' || record.state === 'failed'
        ? new Date(record.updatedAt).toISOString()
        : null,
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    messageId: record.messageId,
    safeErrorCode: record.providerErrorCode,
    retryability: retryabilityForOutboundSendState(record.state),
    state: record.state,
    threadId: record.threadId,
  })
}

async function verifyRequestDigest(request: InternalSendRequest, attachments: readonly File[]) {
  const descriptors = request.command.message.attachments ?? []
  const attachmentDigests = await Promise.all(
    attachments.map(async (attachment, index) => ({
      filename: descriptors[index]?.filename ?? attachment.name,
      mediaType: descriptors[index]?.mediaType ?? safeAttachmentContentType(attachment.type),
      sha256: await sha256Hex(await attachment.arrayBuffer()),
      size: attachment.size,
    })),
  )
  const digest = await computeIdempotencyRequestDigest({
    attachments: attachmentDigests,
    command: request.command,
    version: 1,
  })
  if (digest !== request.requestDigest) throw new MailFault('validation_failed', 400)
}

function normalizeCommandRecipients(message: {
  bcc?: readonly RecipientInput[] | undefined
  cc?: readonly RecipientInput[] | undefined
  to: readonly RecipientInput[]
}) {
  return normalizeRecipientFields(
    {
      bcc: message.bcc?.map(recipientText),
      cc: message.cc?.map(recipientText),
      to: message.to.map(recipientText),
    },
    50,
  )
}

function recipientText(recipient: RecipientInput): string {
  return formatAddress(
    recipient.displayName === undefined
      ? { address: recipient.address }
      : { address: recipient.address, name: recipient.displayName },
  )
}

function recipientProjection(
  kind: 'bcc' | 'cc' | 'to',
  values: readonly { address: string; name?: string }[],
) {
  return values.map((value, position) => ({
    address: value.address,
    displayName: value.name ?? null,
    kind,
    position,
  }))
}

function providerAddresses(values: readonly { address: string; name?: string }[]) {
  return values.map((value): string | EmailAddress =>
    value.name === undefined ? value.address : { email: value.address, name: value.name },
  )
}

function senderAddress(mailbox: MailboxRecord): string | EmailAddress {
  return mailbox.senderAlias === null
    ? mailbox.address
    : { email: mailbox.address, name: mailbox.senderAlias }
}

function selectReplyTarget(
  messages: readonly ReplyContextMessage[],
  selectedMessageId: string | undefined,
): ReplyContextMessage | undefined {
  const selected =
    selectedMessageId === undefined
      ? undefined
      : messages.find(({ direction, id }) => direction === 'inbound' && id === selectedMessageId)
  return selected ?? messages.toReversed().find(({ direction }) => direction === 'inbound')
}

function messageIdentifier(message: ReplyContextMessage | undefined): string | null {
  return message?.internetMessageId ?? message?.providerMessageId ?? null
}

function threadingHeaders(inReplyTo: string | null, references: readonly string[]) {
  const headers: Record<string, string> = {}
  if (inReplyTo !== null) headers['In-Reply-To'] = inReplyTo
  if (references.length > 0) headers['References'] = references.join(' ')
  return Object.keys(headers).length === 0 ? undefined : headers
}

function previewText(text: string, subject: string): string {
  return (text.replace(/\s+/gu, ' ').trim() || subject).slice(0, 500)
}

function responseForRecord(record: Parameters<typeof sendStatusResponse>[0]): InternalSendResult {
  return {
    response: sendStatusResponse(record),
    status: record.state === 'sent' ? 201 : 202,
  }
}
