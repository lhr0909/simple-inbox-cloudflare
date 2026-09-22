import type { UploadedFile } from '@cloudflare-inbox/db'
import { buildContentDisposition } from '@cloudflare-inbox/mail-core'
import { ApiFault } from '../http'
import type { ApiBindings } from '../types'

export function uploadPartSize(size: number): number {
  // R2 permits at most 10,000 parts. Grow parts for very large files rather than
  // imposing a product size limit. All non-final parts have the same size.
  return Math.max(16 * 1024 * 1024, Math.ceil(size / 10_000))
}

export function attachmentBucket(env: ApiBindings): R2Bucket {
  if (!env.ATTACHMENTS) throw new ApiFault('service_unavailable')
  return env.ATTACHMENTS
}

export async function uploadedFileResponse(
  bucket: R2Bucket,
  file: UploadedFile,
  request: Request,
): Promise<Response> {
  // Stream bytes; never buffer a potentially large file in the Worker.
  const object = await bucket.get(file.objectKey, { range: request.headers })
  if (!object || object.etag !== file.etag || object.size !== file.size)
    throw new ApiFault('attachment_not_found')
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'content-disposition': buildContentDisposition(file.filename),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'accept-ranges': 'bytes',
    etag: object.httpEtag,
  })
  const range = object.range
  if (
    request.headers.has('range') &&
    range &&
    'offset' in range &&
    'length' in range &&
    range.offset !== undefined &&
    range.length !== undefined
  ) {
    headers.set(
      'content-range',
      `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`,
    )
    headers.set('content-length', String(range.length))
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers })
  }
  headers.set('content-length', String(object.size))
  return new Response(request.method === 'HEAD' ? null : object.body, { headers })
}
