import { AwsClient } from 'aws4fetch'
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

export function localUploads(env: ApiBindings): boolean {
  const url = new URL(env.APP_ORIGIN)
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

export function requireUploadConfiguration(env: ApiBindings): void {
  attachmentBucket(env)
  if (localUploads(env)) return
  if (
    !env.R2_ACCOUNT_ID ||
    !/^[a-f0-9]{32}$/u.test(env.R2_ACCOUNT_ID) ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  )
    throw new ApiFault('service_unavailable')
}

export async function presignPart(
  env: ApiBindings,
  file: UploadedFile,
  part: number,
): Promise<string> {
  requireUploadConfiguration(env)
  if (localUploads(env)) return `/api/v1/uploads/${file.id}/parts/${part}/local`
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID!,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
    service: 's3',
    region: 'auto',
  })
  const url = new URL(
    `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/simple-inbox-cf-attachments/${file.objectKey}`,
  )
  url.searchParams.set('uploadId', file.multipartId)
  url.searchParams.set('partNumber', String(part))
  url.searchParams.set('X-Amz-Expires', '900')
  return (await client.sign(url, { method: 'PUT', aws: { signQuery: true } })).url
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
