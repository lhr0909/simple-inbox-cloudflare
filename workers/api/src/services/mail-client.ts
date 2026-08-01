import {
  InternalMagicLinkDeliverySchema,
  InternalSendRequestSchema,
  type IdempotencyKey,
  type InternalActor,
  type InternalMagicLinkDelivery,
  type RequestId,
  type SendCommand,
} from '@cloudflare-inbox/contracts'
import { computeIdempotencyRequestDigest, sha256Hex } from '@cloudflare-inbox/mail-core'

const MAIL_ORIGIN = 'https://mail.internal'
const HEALTH_DEADLINE_MS = 5_000
const MAGIC_LINK_DEADLINE_MS = 10_000
const SEND_DEADLINE_MS = 30_000

export async function fetchMailHealth(
  mail: Fetcher,
  requestId: string,
  signal: AbortSignal,
): Promise<Response> {
  return withDeadline(signal, HEALTH_DEADLINE_MS, (deadlineSignal) =>
    mail.fetch(
      new Request(`${MAIL_ORIGIN}/internal/health`, {
        headers: { 'x-request-id': requestId },
        signal: deadlineSignal,
      }),
    ),
  )
}

export async function deliverMagicLink(
  mail: Fetcher,
  delivery: InternalMagicLinkDelivery,
  signal: AbortSignal,
): Promise<Response> {
  const payload = InternalMagicLinkDeliverySchema.parse(delivery)
  return withDeadline(signal, MAGIC_LINK_DEADLINE_MS, (deadlineSignal) =>
    mail.fetch(
      new Request(`${MAIL_ORIGIN}/internal/v1/auth/magic-link`, {
        body: JSON.stringify(payload),
        headers: {
          'content-type': 'application/json',
          'x-request-id': payload.requestId,
        },
        method: 'POST',
        signal: deadlineSignal,
      }),
    ),
  )
}

export async function submitSend(
  mail: Fetcher,
  input: {
    actor: InternalActor
    attachments: readonly File[]
    command: SendCommand
    idempotencyKey: IdempotencyKey
    requestId: RequestId
    signal: AbortSignal
  },
): Promise<Response> {
  const attachmentDigests: Array<{
    filename: string
    mediaType: string
    sha256: string
    size: number
  }> = []
  for (const [index, attachment] of input.attachments.entries()) {
    const descriptor = input.command.message.attachments?.[index]
    if (descriptor === undefined) throw new TypeError('Attachment descriptors and files differ.')
    attachmentDigests.push({
      filename: descriptor.filename,
      mediaType: descriptor.mediaType,
      sha256: await sha256Hex(await attachment.arrayBuffer()),
      size: descriptor.size,
    })
  }
  if ((input.command.message.attachments?.length ?? 0) !== input.attachments.length) {
    throw new TypeError('Attachment descriptors and files differ.')
  }

  const requestDigest = await computeIdempotencyRequestDigest({
    attachments: attachmentDigests,
    command: input.command,
    version: 1,
  })
  const request = InternalSendRequestSchema.parse({
    actor: input.actor,
    command: input.command,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    requestId: input.requestId,
  })

  const body = new FormData()
  body.set('metadata', JSON.stringify(request))
  for (const [index, attachment] of input.attachments.entries()) {
    const descriptor = input.command.message.attachments?.[index]
    if (descriptor !== undefined) {
      body.append(
        'attachments',
        new File([attachment], descriptor.filename, { type: descriptor.mediaType }),
      )
    }
  }

  // Only values derived from the authenticated API context enter the signed
  // request document. No incoming actor/user/mailbox headers are forwarded.
  return withDeadline(input.signal, SEND_DEADLINE_MS, (deadlineSignal) =>
    mail.fetch(
      new Request(`${MAIL_ORIGIN}/internal/v1/send`, {
        body,
        headers: { 'x-request-id': input.requestId },
        method: 'POST',
        signal: deadlineSignal,
      }),
    ),
  )
}

async function withDeadline<T>(
  upstreamSignal: AbortSignal,
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (upstreamSignal.aborted) abort()
  else upstreamSignal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, milliseconds)
  try {
    return await operation(controller.signal)
  } finally {
    clearTimeout(timeout)
    upstreamSignal.removeEventListener('abort', abort)
  }
}
