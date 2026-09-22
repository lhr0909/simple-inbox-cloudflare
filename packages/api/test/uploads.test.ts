import { describe, expect, it } from 'vitest'
import type { UploadedFile } from '@cloudflare-inbox/db'
import { attachmentBucket, uploadPartSize, uploadedFileResponse } from '../src/services/uploads'
import type { ApiBindings } from '../src/types'

const file: UploadedFile = {
  id: '019fbbcf-73c9-7a01-8a00-000000000008',
  ownerUserId: 'owner',
  filename: 'report.txt',
  mediaType: 'text/plain',
  size: 4,
  objectKey: 'attachments/synthetic-id',
  multipartId: 'synthetic/multipart+id',
  downloadToken: 'a'.repeat(64),
  etag: 'expected-etag',
  outboundSendId: null,
  createdAt: 0,
}
const env = {
  APP_ORIGIN: 'https://inbox.example.test',
  STORAGE: {},
} as unknown as ApiBindings

describe('R2 upload and download boundaries', () => {
  it('requires only a bucket binding on production HTTPS origins', () => {
    expect(attachmentBucket(env)).toBe(env.STORAGE)
    expect(() => attachmentBucket({ APP_ORIGIN: env.APP_ORIGIN } as ApiBindings)).toThrow(
      'service_unavailable',
    )
  })

  it('sizes parts within the R2 part-count constraint', () => {
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
