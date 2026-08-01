import { DEFAULT_MAX_RECIPIENTS } from './address'
import { utf8Bytes } from './encoding'

export const MEBIBYTE = 1_024 * 1_024
export const MAX_INBOUND_BYTES = 25 * MEBIBYTE
export const MAX_PROVIDER_ATTACHMENTS = 32

export type ProviderSizeProfileName = 'owner-forward' | 'user-send'

export interface ProviderSizeProfile {
  name: ProviderSizeProfileName
  maxWireBytes: number
  safetyMarginBytes: number
  maxRecipients: number
  maxAttachments: number
}

export const PROVIDER_SIZE_PROFILES: Readonly<
  Record<ProviderSizeProfileName, ProviderSizeProfile>
> = {
  'owner-forward': {
    name: 'owner-forward',
    maxWireBytes: 25 * MEBIBYTE,
    safetyMarginBytes: 256 * 1_024,
    maxRecipients: DEFAULT_MAX_RECIPIENTS,
    maxAttachments: MAX_PROVIDER_ATTACHMENTS,
  },
  'user-send': {
    name: 'user-send',
    maxWireBytes: 5 * MEBIBYTE,
    safetyMarginBytes: 128 * 1_024,
    maxRecipients: DEFAULT_MAX_RECIPIENTS,
    maxAttachments: MAX_PROVIDER_ATTACHMENTS,
  },
}

export interface AttachmentSizeInput {
  size: number
  filename?: string
  contentType?: string
}

export interface OutboundSizeInput {
  text?: string
  html?: string
  attachments?: readonly AttachmentSizeInput[]
  recipientCount?: number
  headerBytes?: number
}

export interface OutboundSizeEstimate {
  bodyBytes: number
  attachmentBytes: number
  structuralBytes: number
  estimatedWireBytes: number
}

export function estimateBase64WireBytes(rawBytes: number): number {
  requireByteCount(rawBytes)
  if (rawBytes === 0) return 0
  const encoded = 4 * Math.ceil(rawBytes / 3)
  return encoded + 2 * Math.ceil(encoded / 76)
}

export function estimateOutboundWireSize(input: OutboundSizeInput): OutboundSizeEstimate {
  const attachments = input.attachments ?? []
  const textBytes = utf8Bytes(input.text ?? '').byteLength
  const htmlBytes = utf8Bytes(input.html ?? '').byteLength
  const bodyBytes = estimateBase64WireBytes(textBytes) + estimateBase64WireBytes(htmlBytes)
  let attachmentBytes = 0
  for (const attachment of attachments) {
    requireByteCount(attachment.size)
    attachmentBytes += estimateBase64WireBytes(attachment.size)
    attachmentBytes +=
      320 +
      utf8Bytes(attachment.filename ?? 'attachment.bin').byteLength +
      utf8Bytes(attachment.contentType ?? 'application/octet-stream').byteLength
  }
  const structuralBytes =
    2_048 +
    (input.headerBytes ?? 0) +
    (input.recipientCount ?? 0) * 96 +
    attachments.length * 160 +
    (htmlBytes > 0 ? 512 : 0)
  return {
    bodyBytes,
    attachmentBytes,
    structuralBytes,
    estimatedWireBytes: bodyBytes + attachmentBytes + structuralBytes,
  }
}

export interface ProviderLimitResult extends OutboundSizeEstimate {
  allowed: boolean
  reasons: Array<'recipient_limit' | 'attachment_limit' | 'message_size_limit'>
  profile: ProviderSizeProfile
  usableWireBytes: number
}

export function checkProviderLimits(
  profileName: ProviderSizeProfileName,
  input: OutboundSizeInput,
): ProviderLimitResult {
  const profile = PROVIDER_SIZE_PROFILES[profileName]
  const estimate = estimateOutboundWireSize(input)
  const reasons: ProviderLimitResult['reasons'] = []
  const recipientCount = input.recipientCount ?? 0
  if (!Number.isSafeInteger(recipientCount) || recipientCount < 0) {
    throw new RangeError('Recipient count must be a non-negative integer.')
  }
  if (recipientCount > profile.maxRecipients) reasons.push('recipient_limit')
  if ((input.attachments?.length ?? 0) > profile.maxAttachments) {
    reasons.push('attachment_limit')
  }
  const usableWireBytes = profile.maxWireBytes - profile.safetyMarginBytes
  if (estimate.estimatedWireBytes > usableWireBytes) reasons.push('message_size_limit')
  return {
    ...estimate,
    allowed: reasons.length === 0,
    reasons,
    profile,
    usableWireBytes,
  }
}

function requireByteCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Byte sizes must be non-negative safe integers.')
  }
}
