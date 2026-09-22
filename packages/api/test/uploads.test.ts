import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '@cloudflare-inbox/db'
import {
  localUploads,
  presignPart,
  uploadPartSize,
  uploadedFileResponse,
} from '../src/services/uploads'
import type { ApiBindings } from '../src/types'

const file: UploadedFile = {
  id: '019fbbcf-73c9-7a01-8a00-000000000008',
  ownerUserId: 'owner',
  filename: 'report.txt',
  mediaType: 'text/plain',
  size: 4,
  objectKey: 'files/synthetic-id',
  multipartId: 'synthetic/multipart+id',
  downloadToken: 'a'.repeat(64),
  etag: 'expected-etag',
  outboundSendId: null,
  createdAt: 0,
}
const env = {
  APP_ORIGIN: 'https://inbox.example.test',
  ATTACHMENTS: {},
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_ACCESS_KEY_ID: 'synthetic-access-key',
  R2_SECRET_ACCESS_KEY: 'synthetic-secret-key',
} as unknown as ApiBindings

describe('R2 upload and download boundaries', () => {
  it('signs a PUT capability for exactly one multipart part with a short lifetime', async () => {
    const url = new URL(await presignPart(env, file, 2))
    expect(url.origin).toBe(`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe('/simple-inbox-cf-attachments/files/synthetic-id')
    expect(url.searchParams.get('uploadId')).toBe(file.multipartId)
    expect(url.searchParams.get('partNumber')).toBe('2')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('/auto/s3/aws4_request')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/u)
    expect(url.href).not.toContain('synthetic-secret-key')
  })

  it('fails closed without production credentials; the local adapter requires loopback HTTP', async () => {
    await expect(presignPart({ ...env, R2_ACCOUNT_ID: '' }, file, 1)).rejects.toThrow(
      'service_unavailable',
    )
    expect(localUploads({ ...env, APP_ORIGIN: 'http://inbox.example.test' })).toBe(false)
    expect(localUploads({ ...env, APP_ORIGIN: 'https://localhost' })).toBe(false)
    expect(await presignPart({ ...env, APP_ORIGIN: 'http://127.0.0.1:8787' }, file, 1)).toBe(
      `/api/v1/uploads/${file.id}/parts/1/local`,
    )
    const largeSize = 1024 ** 4
    expect(Math.ceil(largeSize / uploadPartSize(largeSize))).toBeLessThanOrEqual(10_000)
  })

  it('refuses a replaced object and forces potentially active content to download', async () => {
    const bucket = (etag: string) =>
      ({
        get: async () => ({
          etag,
          size: 4,
          range: { offset: 0, length: 4 },
          httpEtag: `"${etag}"`,
          body: new Response('test').body,
        }),
      }) as unknown as R2Bucket
    const request = new Request('https://inbox.example.test/api/v1/downloads/synthetic')
    await expect(uploadedFileResponse(bucket('replaced'), file, request)).rejects.toThrow(
      'attachment_not_found',
    )
    const response = await uploadedFileResponse(
      bucket(file.etag!),
      { ...file, filename: 'page.html', mediaType: 'text/html' },
      request,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.text()).toBe('test')
  })
})
