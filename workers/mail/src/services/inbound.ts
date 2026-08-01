import {
  DEFAULT_THREAD_FALLBACK_WINDOW_MS,
  appendReference,
  buildInboundRawKey,
  checkProviderLimits,
  computeIdempotencyRequestDigest,
  computeInboundIngestDigest,
  ensureReplySubject,
  normalizeEmailAddress,
  normalizeEnvelopeAddress,
  normalizeMessageId,
  normalizeSubjectForThreading,
  parseMailbox,
  parseReplyAlias,
  renderSafeMessageContent,
  resolveThread,
  sha256Hex,
} from '@cloudflare-inbox/mail-core'
import type { OutboundSendRecord } from '@cloudflare-inbox/db'

import { MailFault, safeProviderErrorCode } from '../errors'
import { logEvent } from '../logging'
import type {
  MailBindings,
  MailDependencies,
  MailStore,
  MailboxRecord,
  NormalizedAttachment,
  NormalizedInboundMessage,
  NormalizedRecipient,
  ReplyAliasRecord,
  ReplyContextMessage,
} from '../types'
import { putInboundRaw, readInboundRaw } from './raw-email'

const PARSE_FAILURE_CODE = 'mime_parse_failed'

export type InboundCaptureOutcome =
  | { kind: 'captured'; messageId: string; threadId: string }
  | { kind: 'duplicate'; messageId: string; threadId: string }
  | { kind: 'rejected'; reason: 'invalid_envelope' | 'oversized' | 'unauthorized_alias' }
  | { kind: 'relay_failed'; sendId: string; threadId: string }
  | { kind: 'relay_unknown'; sendId: string; threadId: string }
  | { kind: 'relayed'; messageId: string; threadId: string }

export async function captureInboundEmail(
  message: ForwardableEmailMessage,
  env: MailBindings,
  dependencies: MailDependencies,
  requestId: string,
): Promise<InboundCaptureOutcome> {
  const startedAt = dependencies.now()
  const configured = requireInboundConfiguration(env)
  let envelopeTo: string
  let envelopeFrom: string | null
  try {
    envelopeTo = normalizeEmailAddress(message.to)
    envelopeFrom = normalizeEnvelopeAddress(message.from, { allowNullReversePath: true })
    if (parseMailbox(envelopeTo).domain !== configured.mailDomain) {
      message.setReject('Recipient domain is not accepted.')
      return { kind: 'rejected', reason: 'invalid_envelope' }
    }
  } catch {
    message.setReject('Envelope address is invalid.')
    return { kind: 'rejected', reason: 'invalid_envelope' }
  }

  const store = dependencies.createStore(env.DB)
  const aliasAddress = parseReplyAlias(envelopeTo, { domain: configured.mailDomain })
  let authorizedAlias: ReplyAliasRecord | null = null
  if (aliasAddress !== null) {
    const resolvedAlias = await store.resolveReplyAlias(aliasAddress.token)
    if (resolvedAlias === undefined || envelopeFrom !== configured.ownerEmail) {
      message.setReject('Reply alias is not active for this sender.')
      logEvent(
        'warn',
        'mail.reply_alias.rejected',
        { environment: env.ENVIRONMENT, outcome: 'rejected', requestId },
        { reason: resolvedAlias === undefined ? 'unknown_alias' : 'sender_mismatch' },
      )
      return { kind: 'rejected', reason: 'unauthorized_alias' }
    }
    authorizedAlias = resolvedAlias
  }

  let raw: Uint8Array
  try {
    raw = await readInboundRaw(message.raw, message.rawSize)
  } catch (error) {
    if (error instanceof MailFault && error.code === 'request_too_large') {
      message.setReject('Message exceeds the accepted size limit.')
      return { kind: 'rejected', reason: 'oversized' }
    }
    throw error
  }
  const receivedAt = dependencies.now()
  logEvent(
    'info',
    'mail.inbound.received',
    { environment: env.ENVIRONMENT, outcome: 'received', requestId },
    { rawSize: raw.byteLength },
  )
  const rawSha256 = await sha256Hex(raw)
  const rawKey = buildInboundRawKey(receivedAt, rawSha256)
  // This is deliberately the first external write after bounded buffering.
  await putInboundRaw(env.RAW_EMAILS, rawKey, raw, rawSha256)

  if (authorizedAlias !== null) {
    if (envelopeFrom === null) throw new Error('Authorized alias sender unexpectedly missing.')
    return relayReplyAlias({
      alias: authorizedAlias,
      dependencies,
      envelopeFrom,
      envelopeTo,
      env,
      raw,
      rawKey,
      rawSha256,
      receivedAt,
      requestId,
      store,
    })
  }

  const ingestDigest = await computeInboundIngestDigest({
    envelopeFrom,
    envelopeTo,
    rawSha256,
  })
  const duplicate = await store.findInboundByDigest(ingestDigest)
  if (duplicate !== undefined) {
    if (duplicate.rawR2Key !== rawKey) {
      await deleteUnprojectedRaw(env, rawKey, requestId, 'duplicate_raw_key')
    }
    await resumePendingOwnerForward({
      dependencies,
      env,
      messageId: duplicate.messageId,
      raw,
      requestId,
      store,
    })
    logEvent(
      'info',
      'mail.inbound.duplicate',
      { environment: env.ENVIRONMENT, outcome: 'duplicate', requestId },
      { messageId: duplicate.messageId, threadId: duplicate.threadId },
    )
    return { kind: 'duplicate', messageId: duplicate.messageId, threadId: duplicate.threadId }
  }

  const mailbox = await store.ensureMailbox({
    mailboxAddress: envelopeTo,
    mailboxId: dependencies.generateId(receivedAt),
    now: receivedAt,
    ownerEmail: configured.ownerEmail,
    userId: dependencies.generateId(receivedAt),
  })
  let parsed: NormalizedInboundMessage
  let parseFailed = false
  try {
    parsed = await dependencies.parseMime(raw, receivedAt)
  } catch {
    parseFailed = true
    parsed = fallbackParsedMessage(envelopeFrom, envelopeTo, configured.mailDomain, receivedAt)
    logEvent(
      'warn',
      'mail.inbound.failed',
      { environment: env.ENVIRONMENT, outcome: 'failed', requestId },
      { code: PARSE_FAILURE_CODE, rawSize: raw.byteLength },
    )
  }

  const threadId = await resolveInboundThread(
    store,
    mailbox,
    parsed,
    receivedAt,
    configured.ownerEmail,
  )
  const createdThread = threadId === undefined
  const resolvedThreadId = threadId ?? dependencies.generateId(receivedAt)
  const newThread = createdThread
    ? {
        createdAt: receivedAt,
        id: resolvedThreadId,
        lastMessageAt: parsed.sentAt,
        mailboxId: mailbox.id,
        normalizedSubject: normalizeSubjectForThreading(parsed.subject),
        subject: parsed.subject,
        updatedAt: receivedAt,
        workflowState: 'needs_reply' as const,
      }
    : undefined

  const messageId = dependencies.generateId(receivedAt)
  const attachments = parsed.attachments.map((attachment, mimeOrdinal) => ({
    attachment,
    id: dependencies.generateId(receivedAt),
    mimeOrdinal,
  }))
  const forwardingEnabled = mailbox.forwardTo !== null
  try {
    await store.projectInboundMessage({
      ...(newThread === undefined ? {} : { newThread }),
      projection: {
        attachments: attachments.map(({ attachment, id, mimeOrdinal }) => ({
          contentId: attachment.contentId,
          createdAt: receivedAt,
          displayFilename: attachment.filename,
          disposition: attachment.disposition,
          id,
          mediaType: attachment.mediaType,
          mimeOrdinal,
          size: attachment.bytes.byteLength,
        })),
        message: {
          createdAt: receivedAt,
          direction: 'inbound',
          forwardAttemptedAt: forwardingEnabled && parseFailed ? receivedAt : null,
          forwardState: !forwardingEnabled ? 'not_applicable' : parseFailed ? 'failed' : 'pending',
          fromAddress: parsed.from.address,
          fromName: parsed.from.displayName,
          htmlBody: parsed.html,
          htmlPolicy: 'sanitized',
          id: messageId,
          inReplyTo: parsed.inReplyTo,
          ingestDigest,
          internetMessageId: parsed.internetMessageId,
          mailboxId: mailbox.id,
          preview: previewText(parsed.text, parsed.subject),
          providerErrorCode: parseFailed ? PARSE_FAILURE_CODE : null,
          providerMessageId: null,
          rawR2Key: rawKey,
          rawSha256,
          rawSize: raw.byteLength,
          readAt: null,
          receivedAt,
          sendAttemptedAt: null,
          sendState: 'not_applicable',
          sentAt: parsed.sentAt,
          subject: parsed.subject,
          textBody: parsed.text,
          threadId: resolvedThreadId,
          updatedAt: receivedAt,
        },
        recipients: recipientProjections(parsed, envelopeTo),
        references: parsed.references.map((internetMessageId, position) => ({
          internetMessageId,
          position,
        })),
      },
    })
  } catch (error) {
    try {
      const concurrentProjection = await store.findInboundByDigest(ingestDigest)
      if (concurrentProjection?.rawR2Key !== rawKey) {
        await deleteUnprojectedRaw(env, rawKey, requestId, 'inbound_projection_failed')
      }
    } catch {
      // When ownership cannot be proven, retain the object for the configured
      // lifecycle backstop rather than risk deleting a concurrent winner's raw.
      logEvent(
        'warn',
        'mail.inbound.cleanup_failed',
        { environment: env.ENVIRONMENT, outcome: 'failed', requestId },
        { code: 'raw_projection_ownership_unknown' },
      )
    }
    throw error
  }

  if (!parseFailed && mailbox.forwardTo !== null) {
    await deliverPendingOwnerForward({
      attachments,
      dependencies,
      env,
      forwardTo: mailbox.forwardTo,
      mailbox,
      messageId,
      parsed,
      requestId,
      relayDestination: parsed.replyTo[0]?.address ?? parsed.from.address,
      store,
      threadId: resolvedThreadId,
    })
  }

  logEvent(
    'info',
    'mail.inbound.persisted',
    { environment: env.ENVIRONMENT, outcome: 'completed', requestId },
    {
      durationMs: dependencies.now() - startedAt,
      messageId,
      rawSize: raw.byteLength,
      threadId: resolvedThreadId,
    },
  )
  return { kind: 'captured', messageId, threadId: resolvedThreadId }
}

async function resolveInboundThread(
  store: MailStore,
  mailbox: MailboxRecord,
  parsed: NormalizedInboundMessage,
  receivedAt: number,
  ownerEmail: string,
): Promise<string | undefined> {
  const ids = [
    ...(parsed.inReplyTo === null ? [] : [parsed.inReplyTo]),
    ...parsed.references.toReversed(),
  ]
  const direct = await store.findThreadByMessageIds(mailbox.id, ids)
  if (direct !== undefined) return direct

  const normalizedSubject = normalizeSubjectForThreading(parsed.subject)
  if (!normalizedSubject) return undefined
  const ignored = new Set([
    mailbox.address,
    ownerEmail,
    ...(mailbox.forwardTo === null ? [] : [mailbox.forwardTo]),
  ])
  const participants = participantAddresses(parsed).filter((address) => !ignored.has(address))
  const candidates = await store.listSubjectThreadCandidates({
    mailboxId: mailbox.id,
    normalizedSubject,
    receivedAt,
    windowMs: DEFAULT_THREAD_FALLBACK_WINDOW_MS,
  })
  const resolution = resolveThread({
    fallbackCandidates: candidates.map((candidate) => ({
      ...candidate,
      participants: candidate.participants.filter((address) => !ignored.has(address)),
    })),
    knownMessages: [],
    mailboxId: mailbox.id,
    participants,
    receivedAt,
    subject: parsed.subject,
  })
  return resolution.kind === 'subject_participants' ? resolution.threadId : undefined
}

async function allocateReplyAlias(
  store: MailStore,
  dependencies: MailDependencies,
  input: {
    mailbox: MailboxRecord
    messageId: string
    now: number
    relayDestination: string
    threadId: string
  },
): Promise<ReplyAliasRecord | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const alias = await store.ensureReplyAlias({
      aliasId: dependencies.generateId(input.now),
      localPart: dependencies.generateAliasToken(),
      mailboxId: input.mailbox.id,
      now: input.now,
      relayDestination: input.relayDestination,
      targetMessageId: input.messageId,
      threadId: input.threadId,
    })
    if (alias !== undefined) return alias
  }
  return undefined
}

async function resumePendingOwnerForward(input: {
  dependencies: MailDependencies
  env: MailBindings
  messageId: string
  raw: Uint8Array
  requestId: string
  store: MailStore
}): Promise<void> {
  const context = await input.store.getInboundForwardContext(input.messageId)
  if (
    context === undefined ||
    context.forwardState !== 'pending' ||
    context.mailbox.forwardTo === null
  ) {
    return
  }

  let parsed: NormalizedInboundMessage
  try {
    parsed = await input.dependencies.parseMime(input.raw, context.receivedAt)
  } catch {
    await input.store.updateForwardResult({
      messageId: context.messageId,
      now: input.dependencies.now(),
      providerErrorCode: PARSE_FAILURE_CODE,
      providerMessageId: null,
      state: 'failed',
    })
    return
  }

  const attachmentIds = new Map(
    context.attachments.map(({ id, mimeOrdinal }) => [mimeOrdinal, id] as const),
  )
  const attachments = parsed.attachments.map((attachment, mimeOrdinal) => ({
    attachment,
    id: attachmentIds.get(mimeOrdinal) ?? '',
    mimeOrdinal,
  }))
  if (
    attachments.length !== context.attachments.length ||
    attachments.some(({ id }) => id.length === 0)
  ) {
    await input.store.updateForwardResult({
      messageId: context.messageId,
      now: input.dependencies.now(),
      providerErrorCode: 'forward_resume_attachment_mismatch',
      providerMessageId: null,
      state: 'failed',
    })
    return
  }

  await deliverPendingOwnerForward({
    attachments,
    dependencies: input.dependencies,
    env: input.env,
    forwardTo: context.mailbox.forwardTo,
    mailbox: context.mailbox,
    messageId: context.messageId,
    parsed,
    relayDestination: parsed.replyTo[0]?.address ?? parsed.from.address,
    requestId: input.requestId,
    store: input.store,
    threadId: context.threadId,
  })
}

async function deliverPendingOwnerForward(input: {
  attachments: Array<{ attachment: NormalizedAttachment; id: string; mimeOrdinal: number }>
  dependencies: MailDependencies
  env: MailBindings
  forwardTo: string
  mailbox: MailboxRecord
  messageId: string
  parsed: NormalizedInboundMessage
  relayDestination: string
  requestId: string
  store: MailStore
  threadId: string
}): Promise<void> {
  const alias = await allocateReplyAlias(input.store, input.dependencies, {
    mailbox: input.mailbox,
    messageId: input.messageId,
    now: input.dependencies.now(),
    relayDestination: input.relayDestination,
    threadId: input.threadId,
  })
  if (alias === undefined) {
    await input.store.updateForwardResult({
      messageId: input.messageId,
      now: input.dependencies.now(),
      providerErrorCode: 'reply_alias_unavailable',
      providerMessageId: null,
      state: 'failed',
    })
    return
  }

  const claimed = await input.store.claimPendingForward({
    messageId: input.messageId,
    now: input.dependencies.now(),
  })
  if (!claimed) return

  await forwardToOwner({
    alias,
    attachments: input.attachments,
    env: input.env,
    forwardTo: input.forwardTo,
    mailbox: input.mailbox,
    messageId: input.messageId,
    now: () => input.dependencies.now(),
    parsed: input.parsed,
    requestId: input.requestId,
    store: input.store,
  })
}

async function forwardToOwner(input: {
  alias: ReplyAliasRecord
  attachments: Array<{ attachment: NormalizedAttachment; id: string; mimeOrdinal: number }>
  env: MailBindings
  forwardTo: string
  mailbox: MailboxRecord
  messageId: string
  parsed: NormalizedInboundMessage
  requestId: string
  store: MailStore
  now(): number
}): Promise<void> {
  const replyTo = `reply+${input.alias.localPart}@${parseMailbox(input.mailbox.address).domain}`
  let text = input.parsed.text
  let html = input.parsed.html
  let providerAttachments = input.attachments.map(({ attachment }) =>
    providerAttachment(attachment),
  )
  const limit = checkProviderLimits('owner-forward', {
    attachments: input.attachments.map(({ attachment }) => ({
      contentType: attachment.mediaType,
      filename: attachment.filename,
      size: attachment.bytes.byteLength,
    })),
    html,
    recipientCount: 1,
    text,
  })
  if (!limit.allowed) {
    const links = input.attachments.map(
      ({ attachment, id }) =>
        `${attachment.filename}: ${new URL(`/api/v1/messages/${input.messageId}/attachments/${id}`, input.env.APP_ORIGIN).href}`,
    )
    const notice = links.length
      ? `\n\nAttachments were retained in the inbox and can be downloaded after sign-in:\n${links.join('\n')}`
      : '\n\nThis message was retained in the inbox because the forwarded copy exceeded provider limits.'
    const bodyOnly = checkProviderLimits('owner-forward', {
      html,
      recipientCount: 1,
      text,
    })
    text = bodyOnly.allowed
      ? `${text}${notice}`
      : `This message was retained in the inbox because the forwarded copy exceeded provider limits.\n\n${new URL(`/api/v1/messages/${input.messageId}/raw`, input.env.APP_ORIGIN).href}`
    html = renderSafeMessageContent({ source: 'inbound', text }).html
    providerAttachments = []
  }

  const attemptedAt = input.now()
  try {
    const result = await input.env.EMAIL.send({
      attachments: providerAttachments,
      from: senderAddress(input.mailbox),
      html,
      replyTo,
      subject: input.parsed.subject,
      text,
      to: input.forwardTo,
    })
    await input.store.updateForwardResult({
      messageId: input.messageId,
      now: attemptedAt,
      providerErrorCode: null,
      providerMessageId: result.messageId,
      state: 'forwarded',
    })
    logEvent(
      'info',
      'mail.forward.completed',
      {
        environment: input.env.ENVIRONMENT,
        outcome: 'completed',
        requestId: input.requestId,
      },
      { messageId: input.messageId },
    )
  } catch (error) {
    await input.store.updateForwardResult({
      messageId: input.messageId,
      now: attemptedAt,
      providerErrorCode: safeProviderErrorCode(error, 'owner_forward_failed'),
      providerMessageId: null,
      state: 'unknown',
    })
    logEvent(
      'warn',
      'mail.forward.failed',
      { environment: input.env.ENVIRONMENT, outcome: 'unknown', requestId: input.requestId },
      { messageId: input.messageId },
    )
  }
}

async function relayReplyAlias(input: {
  alias: ReplyAliasRecord
  dependencies: MailDependencies
  envelopeFrom: string
  envelopeTo: string
  env: MailBindings
  raw: Uint8Array
  rawKey: string
  rawSha256: string
  receivedAt: number
  requestId: string
  store: MailStore
}): Promise<InboundCaptureOutcome> {
  if (
    await input.store.hasRawProjection({
      direction: 'outbound',
      mailboxId: input.alias.mailboxId,
      rawSha256: input.rawSha256,
    })
  ) {
    return {
      kind: 'duplicate',
      messageId: input.alias.targetMessageId ?? '',
      threadId: input.alias.threadId,
    }
  }

  const context = await input.store.getOutboundContext({
    actorUserId: input.alias.ownerUserId,
    mailboxId: input.alias.mailboxId,
    threadId: input.alias.threadId,
  })
  if (context?.thread === undefined) {
    await deleteUnprojectedRaw(
      input.env,
      input.rawKey,
      input.requestId,
      'reply_alias_context_unavailable',
    )
    throw new Error('Reply alias points to an unavailable thread.')
  }
  let parsed: NormalizedInboundMessage
  let parseFailed = false
  try {
    parsed = await input.dependencies.parseMime(input.raw, input.receivedAt)
  } catch {
    parseFailed = true
    parsed = fallbackParsedMessage(
      input.envelopeFrom,
      input.envelopeTo,
      parseMailbox(input.envelopeTo).domain,
      input.receivedAt,
    )
  }

  const messageId = input.dependencies.generateId(input.receivedAt)
  const proposedSendId = input.dependencies.generateId(input.receivedAt)
  const ingestDigest = await computeInboundIngestDigest({
    envelopeFrom: input.envelopeFrom,
    envelopeTo: input.envelopeTo,
    rawSha256: input.rawSha256,
  })
  const requestDigest = await computeIdempotencyRequestDigest({
    ingestDigest,
    kind: 'reply_alias_relay',
    threadId: input.alias.threadId,
    version: 1,
  })
  const reservation = await input.store.reserveOutboundSend({
    actorUserId: input.alias.ownerUserId,
    createdAt: input.receivedAt,
    id: proposedSendId,
    idempotencyKey: `relay-${ingestDigest}`,
    mailboxId: input.alias.mailboxId,
    requestDigest,
    threadId: input.alias.threadId,
  })
  if (reservation.kind === 'conflict') {
    await deleteUnprojectedRaw(
      input.env,
      input.rawKey,
      input.requestId,
      'reply_alias_terminal_replay',
    )
    return {
      kind: 'duplicate',
      messageId,
      threadId: input.alias.threadId,
    }
  }
  const sendId = reservation.send.id
  if (reservation.send.state !== 'queued') {
    if (reservation.send.state === 'failed' && reservation.send.messageId === null) {
      await deleteUnprojectedRaw(
        input.env,
        input.rawKey,
        input.requestId,
        'reply_alias_terminal_replay',
      )
    }
    return relayReplayOutcome(reservation.send, messageId, input.alias.threadId)
  }

  const target = selectContextTarget(context.messages, input.alias.targetMessageId)
  const allowed = new Set(
    await input.store.listAllowedRelayDestinations(input.alias.mailboxId, input.alias.threadId),
  )
  const excluded = new Set([input.envelopeFrom, input.envelopeTo, context.mailbox.address])
  const recipients = [
    input.alias.relayDestination,
    ...parsed.to.map(({ address }) => address),
    ...parsed.cc.map(({ address }) => address),
  ].filter(
    (address, index, all) =>
      allowed.has(address) && !excluded.has(address) && all.indexOf(address) === index,
  )
  if (!recipients.includes(input.alias.relayDestination))
    recipients.unshift(input.alias.relayDestination)
  const references = appendReference(target?.references ?? [], targetMessageIdentifier(target))
  const attachments = parsed.attachments
  const limit = checkProviderLimits('user-send', {
    attachments: attachments.map((attachment) => ({
      contentType: attachment.mediaType,
      filename: attachment.filename,
      size: attachment.bytes.byteLength,
    })),
    html: parsed.html,
    recipientCount: recipients.length,
    text: parsed.text,
  })

  const definiteFailureCode = parseFailed
    ? PARSE_FAILURE_CODE
    : target === undefined
      ? 'reply_target_invalid'
      : !limit.allowed
        ? `provider_${limit.reasons[0] ?? 'limit'}`
        : null
  if (definiteFailureCode !== null) {
    await input.store.recordOutboundAttempt({
      actorUserId: input.alias.ownerUserId,
      id: sendId,
      mailboxId: input.alias.mailboxId,
      messageId: null,
      now: input.dependencies.now(),
      providerErrorCode: definiteFailureCode,
      providerMessageId: null,
      requestDigest,
      state: 'failed',
    })
    logEvent(
      'warn',
      'mail.reply_alias.failed',
      { environment: input.env.ENVIRONMENT, outcome: 'failed', requestId: input.requestId },
      { code: definiteFailureCode, sendId, threadId: input.alias.threadId },
    )
    await deleteUnprojectedRaw(
      input.env,
      input.rawKey,
      input.requestId,
      'reply_alias_definite_failure',
    )
    return { kind: 'relay_failed', sendId, threadId: input.alias.threadId }
  }

  const claimed = await input.store.claimQueuedSend({
    actorUserId: input.alias.ownerUserId,
    id: sendId,
    mailboxId: input.alias.mailboxId,
    now: input.receivedAt,
    requestDigest,
  })
  if (!claimed) {
    const current = await input.store.findSendByIdempotencyKey(`relay-${ingestDigest}`)
    return current === undefined
      ? { kind: 'relay_unknown', sendId, threadId: input.alias.threadId }
      : relayReplayOutcome(current, messageId, input.alias.threadId)
  }

  let providerMessageId: string | null = null
  let providerErrorCode: string | null = null
  let state: 'sent' | 'unknown'
  logEvent(
    'info',
    'mail.outbound.started',
    { environment: input.env.ENVIRONMENT, outcome: 'started', requestId: input.requestId },
    { outboundSendId: sendId, source: 'reply_alias', threadId: input.alias.threadId },
  )
  try {
    const headers = threadingHeaders(targetMessageIdentifier(target), references)
    const result = await input.env.EMAIL.send({
      attachments: attachments.map(providerAttachment),
      from: senderAddress(context.mailbox),
      ...(headers === undefined ? {} : { headers }),
      html: parsed.html,
      replyTo: context.mailbox.address,
      subject: ensureReplySubject(parsed.subject || context.thread.subject),
      text: parsed.text,
      to: recipients,
    })
    providerMessageId = result.messageId
    state = 'sent'
  } catch (error) {
    state = 'unknown'
    providerErrorCode = safeProviderErrorCode(error, 'provider_send_unknown')
  }

  const projectedAttachments = attachments.map((attachment, mimeOrdinal) => ({
    attachment,
    id: input.dependencies.generateId(input.receivedAt),
    mimeOrdinal,
  }))
  const projection = {
    attachments: projectedAttachments.map(({ attachment, id, mimeOrdinal }) => ({
      contentId: attachment.contentId,
      createdAt: input.receivedAt,
      displayFilename: attachment.filename,
      disposition: attachment.disposition,
      id,
      mediaType: attachment.mediaType,
      mimeOrdinal,
      size: attachment.bytes.byteLength,
    })),
    message: {
      createdAt: input.receivedAt,
      direction: 'outbound' as const,
      forwardAttemptedAt: null,
      forwardState: 'not_applicable' as const,
      fromAddress: context.mailbox.address,
      fromName: context.mailbox.senderAlias,
      htmlBody: parsed.html,
      htmlPolicy: 'sanitized' as const,
      id: messageId,
      inReplyTo: targetMessageIdentifier(target),
      ingestDigest: null,
      internetMessageId: normalizeMessageId(providerMessageId),
      mailboxId: input.alias.mailboxId,
      preview: previewText(parsed.text, parsed.subject),
      providerErrorCode,
      providerMessageId,
      rawR2Key: input.rawKey,
      rawSha256: input.rawSha256,
      rawSize: input.raw.byteLength,
      readAt: null,
      receivedAt: input.receivedAt,
      sendAttemptedAt: input.receivedAt,
      sendState: state,
      sentAt: parsed.sentAt,
      subject: ensureReplySubject(parsed.subject || context.thread.subject),
      textBody: parsed.text,
      threadId: input.alias.threadId,
      updatedAt: input.receivedAt,
    },
    recipients: recipients.map((address, position) => ({
      address,
      displayName: null,
      kind: 'to' as const,
      position,
    })),
    references: references.map((internetMessageId, position) => ({
      internetMessageId,
      position,
    })),
  }
  try {
    await input.store.completeOutboundProjection({
      actorUserId: input.alias.ownerUserId,
      now: input.dependencies.now(),
      outboundSendId: sendId,
      projection,
      requestDigest,
    })
  } catch (error) {
    const code = safeProviderErrorCode(error, 'projection_after_send_unknown')
    logEvent(
      'warn',
      'mail.reply_alias.unknown',
      { environment: input.env.ENVIRONMENT, outcome: 'unknown', requestId: input.requestId },
      { code, sendId, threadId: input.alias.threadId },
    )
    return { kind: 'relay_unknown', sendId, threadId: input.alias.threadId }
  }
  logEvent(
    state === 'sent' ? 'info' : 'warn',
    `mail.reply_alias.${state}`,
    { environment: input.env.ENVIRONMENT, outcome: state, requestId: input.requestId },
    { messageId, state, threadId: input.alias.threadId },
  )
  if (state === 'sent') {
    logEvent(
      'info',
      'mail.outbound.completed',
      { environment: input.env.ENVIRONMENT, outcome: 'completed', requestId: input.requestId },
      { messageId, outboundSendId: sendId, source: 'reply_alias', state },
    )
  }
  return state === 'sent'
    ? { kind: 'relayed', messageId, threadId: input.alias.threadId }
    : { kind: 'relay_unknown', sendId, threadId: input.alias.threadId }
}

function relayReplayOutcome(
  send: OutboundSendRecord,
  fallbackMessageId: string,
  threadId: string,
): InboundCaptureOutcome {
  if (send.state === 'sent') {
    return { kind: 'duplicate', messageId: send.messageId ?? fallbackMessageId, threadId }
  }
  if (send.state === 'failed') return { kind: 'relay_failed', sendId: send.id, threadId }
  return { kind: 'relay_unknown', sendId: send.id, threadId }
}

async function deleteUnprojectedRaw(
  env: MailBindings,
  rawKey: string,
  requestId: string,
  reason: string,
): Promise<void> {
  try {
    await env.RAW_EMAILS.delete(rawKey)
    logEvent(
      'info',
      'mail.inbound.raw_cleanup',
      { environment: env.ENVIRONMENT, outcome: 'completed', requestId },
      { reason },
    )
  } catch {
    logEvent(
      'warn',
      'mail.inbound.raw_cleanup',
      { environment: env.ENVIRONMENT, outcome: 'failed', requestId },
      { reason },
    )
  }
}

function fallbackParsedMessage(
  envelopeFrom: string | null,
  envelopeTo: string,
  mailDomain: string,
  receivedAt: number,
): NormalizedInboundMessage {
  const text = 'This message was captured, but its MIME content could not be parsed.'
  const rendered = renderSafeMessageContent({ source: 'inbound', text })
  return {
    attachments: [],
    bcc: [],
    cc: [],
    from: { address: envelopeFrom ?? `mailer-daemon@${mailDomain}`, displayName: null },
    html: rendered.html,
    inReplyTo: null,
    internetMessageId: null,
    references: [],
    replyTo: [],
    sentAt: receivedAt,
    subject: 'No subject',
    text: rendered.text,
    to: [{ address: envelopeTo, displayName: null }],
  }
}

function recipientProjections(
  parsed: NormalizedInboundMessage,
  envelopeTo: string,
): Array<{
  address: string
  displayName: string | null
  kind: 'bcc' | 'cc' | 'reply_to' | 'to'
  position: number
}> {
  const to = parsed.to.length === 0 ? [{ address: envelopeTo, displayName: null }] : parsed.to
  return [
    ...projectRecipients('to', to),
    ...projectRecipients('cc', parsed.cc),
    ...projectRecipients('bcc', parsed.bcc),
    ...projectRecipients('reply_to', parsed.replyTo),
  ]
}

function projectRecipients(
  kind: 'bcc' | 'cc' | 'reply_to' | 'to',
  recipients: readonly NormalizedRecipient[],
) {
  return recipients.map((recipient, position) => ({ ...recipient, kind, position }))
}

function participantAddresses(parsed: NormalizedInboundMessage): string[] {
  return [
    parsed.from.address,
    ...parsed.to.map(({ address }) => address),
    ...parsed.cc.map(({ address }) => address),
    ...parsed.replyTo.map(({ address }) => address),
  ]
}

function providerAttachment(attachment: NormalizedAttachment): EmailAttachment {
  return attachment.disposition === 'inline' && attachment.contentId !== null
    ? {
        content: attachment.bytes,
        contentId: attachment.contentId,
        disposition: 'inline',
        filename: attachment.filename,
        type: attachment.mediaType,
      }
    : {
        content: attachment.bytes,
        disposition: 'attachment',
        filename: attachment.filename,
        type: attachment.mediaType,
      }
}

function senderAddress(mailbox: MailboxRecord): string | EmailAddress {
  return mailbox.senderAlias === null
    ? mailbox.address
    : { email: mailbox.address, name: mailbox.senderAlias }
}

function selectContextTarget(
  messages: readonly ReplyContextMessage[],
  selectedMessageId: string | null,
): ReplyContextMessage | undefined {
  const selected =
    selectedMessageId === null
      ? undefined
      : messages.find(({ direction, id }) => direction === 'inbound' && id === selectedMessageId)
  return selected ?? messages.toReversed().find(({ direction }) => direction === 'inbound')
}

function targetMessageIdentifier(target: ReplyContextMessage | undefined): string | null {
  return target?.internetMessageId ?? target?.providerMessageId ?? null
}

function threadingHeaders(
  inReplyTo: string | null,
  references: readonly string[],
): Record<string, string> | undefined {
  const headers: Record<string, string> = {}
  if (inReplyTo !== null) headers['In-Reply-To'] = inReplyTo
  if (references.length > 0) headers['References'] = references.join(' ')
  return Object.keys(headers).length === 0 ? undefined : headers
}

function previewText(text: string, subject: string): string {
  return (text.replace(/\s+/gu, ' ').trim() || subject).slice(0, 500)
}

function requireInboundConfiguration(env: MailBindings): {
  mailDomain: string
  ownerEmail: string
} {
  try {
    const mailDomain = parseMailbox(`mailbox@${env.MAIL_DOMAIN}`).domain
    const ownerEmail = normalizeEmailAddress(env.OWNER_EMAIL)
    const appOrigin = new URL(env.APP_ORIGIN)
    if (appOrigin.username || appOrigin.password || appOrigin.pathname !== '/') throw new Error()
    if (env.ENVIRONMENT === 'production' && appOrigin.protocol !== 'https:') throw new Error()
    return { mailDomain, ownerEmail }
  } catch {
    throw new MailFault('service_unavailable', 503)
  }
}
