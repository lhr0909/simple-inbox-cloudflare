import type { AuthorizedAttachment, AuthorizedRawMessage } from '@cloudflare-inbox/db'
import {
  MAX_INBOUND_BYTES,
  buildContentDisposition,
  safeAttachmentContentType,
  sanitizeFilename,
} from '@cloudflare-inbox/mail-core'
import PostalMime from 'postal-mime'

import { ApiFault } from '../http'

export async function rawMessageResponse(
  bucket: R2Bucket,
  metadata: AuthorizedRawMessage,
  request: Request,
): Promise<Response> {
  requireBoundedRawMetadata(metadata)
  const etag = quoteEtag(metadata.rawSha256)
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return privateBinaryResponse(null, 304, { etag })
  }

  const object = await bucket.get(metadata.rawR2Key)
  if (object === null || !matchesRawObject(object, metadata)) throw new ApiFault('internal_error')

  return privateBinaryResponse(object.body, 200, {
    contentDisposition: buildContentDisposition(`${metadata.id}.eml`),
    contentLength: metadata.rawSize,
    contentType: 'message/rfc822',
    etag,
  })
}

export async function attachmentResponse(
  bucket: R2Bucket,
  metadata: AuthorizedAttachment,
  request: Request,
): Promise<Response> {
  requireBoundedRawMetadata(metadata)
  if (
    !Number.isSafeInteger(metadata.mimeOrdinal) ||
    metadata.mimeOrdinal < 0 ||
    !Number.isSafeInteger(metadata.size) ||
    metadata.size < 0 ||
    metadata.size > metadata.rawSize
  ) {
    throw new ApiFault('internal_error')
  }
  const etag = quoteEtag(`${metadata.rawSha256}-${metadata.mimeOrdinal}`)
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return privateBinaryResponse(null, 304, { etag })
  }

  const object = await bucket.get(metadata.rawR2Key)
  if (object === null || !matchesRawObject(object, metadata)) throw new ApiFault('internal_error')
  const raw = await new Response(object.body).arrayBuffer()
  if (raw.byteLength !== metadata.rawSize) throw new ApiFault('internal_error')

  const parsed = await new PostalMime().parse(raw)
  const attachment = parsed.attachments[metadata.mimeOrdinal]
  if (attachment === undefined) throw new ApiFault('internal_error')
  const bytes = toBytes(attachment.content)
  if (
    bytes.byteLength !== metadata.size ||
    normalizedMediaType(attachment.mimeType) !== normalizedMediaType(metadata.mediaType) ||
    normalizeDisposition(attachment.disposition) !== normalizeDisposition(metadata.disposition) ||
    normalizeContentId(attachment.contentId) !== normalizeContentId(metadata.contentId) ||
    sanitizeFilename(attachment.filename) !== sanitizeFilename(metadata.displayFilename)
  ) {
    throw new ApiFault('internal_error')
  }

  return privateBinaryResponse(Uint8Array.from(bytes).buffer, 200, {
    contentDisposition: buildContentDisposition(metadata.displayFilename),
    contentLength: bytes.byteLength,
    contentType: safeAttachmentContentType(metadata.mediaType),
    etag,
  })
}

function privateBinaryResponse(
  body: BodyInit | null,
  status: 200 | 304,
  options: {
    contentDisposition?: string
    contentLength?: number
    contentType?: string
    etag: string
  },
): Response {
  const headers = new Headers({
    'cache-control': 'private, no-store',
    etag: options.etag,
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  if (options.contentDisposition !== undefined) {
    headers.set('content-disposition', options.contentDisposition)
  }
  if (options.contentLength !== undefined) {
    headers.set('content-length', String(options.contentLength))
  }
  if (options.contentType !== undefined) headers.set('content-type', options.contentType)
  return new Response(body, { headers, status })
}

function requireBoundedRawMetadata(metadata: { rawSha256: string; rawSize: number }): void {
  if (
    !/^[0-9a-f]{64}$/u.test(metadata.rawSha256) ||
    !Number.isSafeInteger(metadata.rawSize) ||
    metadata.rawSize < 0 ||
    metadata.rawSize > MAX_INBOUND_BYTES
  ) {
    throw new ApiFault('internal_error')
  }
}

function matchesRawObject(
  object: R2ObjectBody,
  metadata: { rawSha256: string; rawSize: number },
): boolean {
  return (
    object.size === metadata.rawSize && object.customMetadata?.['sha256'] === metadata.rawSha256
  )
}

function quoteEtag(value: string): string {
  return `"${value}"`
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false
  return header
    .split(',')
    .map((value) => value.trim().replace(/^W\//u, ''))
    .some((value) => value === '*' || value === etag)
}

function normalizedMediaType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function normalizeDisposition(
  value: string | null | undefined,
): 'attachment' | 'inline' | 'unknown' {
  const normalized = value?.trim().toLowerCase()
  return normalized === 'attachment' || normalized === 'inline' ? normalized : 'unknown'
}

function normalizeContentId(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/^<|>$/gu, '')
  return normalized ? normalized : null
}

function toBytes(value: string | ArrayBuffer | Uint8Array | null | undefined): Uint8Array {
  if (value === null || value === undefined) return new Uint8Array()
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}
