import {
  createUploadRoute,
  uploadPartRoute,
  completeUploadRoute,
  downloadSharedFileRoute,
} from '@cloudflare-inbox/contracts'
import { UploadedFileRepository } from '@cloudflare-inbox/db'
import { sanitizeFilename, safeAttachmentContentType } from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { requireActor, requireCookieMutationOrigin } from '../auth'
import { ApiFault } from '../http'
import { attachmentBucket, uploadedFileResponse, uploadPartSize } from '../services/uploads'
import type { ApiDependencies, ApiEnv } from '../types'

export function registerUploadRoutes(
  app: OpenAPIHono<ApiEnv>,
  dependencies: ApiDependencies,
): void {
  app.openapi(createUploadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const input = context.req.valid('json')
    const bucket = attachmentBucket(context.env)
    const id = dependencies.generateId(dependencies.now())
    const objectKey = `files/${id}`
    const filename = sanitizeFilename(input.filename)
    const mediaType = safeAttachmentContentType(input.mediaType)
    const upload =
      input.size === 0
        ? null
        : await bucket.createMultipartUpload(objectKey, {
            httpMetadata: { contentType: 'application/octet-stream' },
          })
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    const repository = new UploadedFileRepository(context.env.DB)
    try {
      await repository.create({
        ...input,
        id,
        filename,
        mediaType,
        objectKey,
        multipartId: upload?.uploadId ?? '',
        downloadToken: token,
        ownerUserId: actor.userId,
        etag: null,
        outboundSendId: null,
        createdAt: dependencies.now(),
      })
      if (!upload) {
        const object = await bucket.put(objectKey, new Uint8Array())
        if (!object) throw new ApiFault('internal_error')
        await repository.complete(id, actor.userId, object.etag)
      }
    } catch (error) {
      await upload?.abort()
      throw error
    }
    return context.json(
      { id, partSize: uploadPartSize(input.size), complete: input.size === 0 },
      201,
    )
  })

  app.openapi(uploadPartRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const { uploadId, partNumber } = context.req.valid('param')
    const file = await new UploadedFileRepository(context.env.DB).owned(uploadId, actor.userId)
    if (!file) throw new ApiFault('attachment_not_found')
    if (file.etag || partNumber > Math.ceil(file.size / uploadPartSize(file.size)))
      throw new ApiFault('validation_failed')
    if (!context.req.raw.body) throw new ApiFault('validation_failed')
    // R2 needs a known-length stream. Enforce the session's expected part size
    // while streaming, including when the incoming request has no Content-Length.
    const partSize = uploadPartSize(file.size)
    const expectedSize = Math.min(partSize, file.size - (partNumber - 1) * partSize)
    const upload = attachmentBucket(context.env).resumeMultipartUpload(
      file.objectKey,
      file.multipartId,
    )
    const stream = new FixedLengthStream(expectedSize)
    const controller = new AbortController()
    const writing = context.req.raw.body.pipeTo(stream.writable, { signal: controller.signal })
    try {
      const [, part] = await Promise.all([writing, upload.uploadPart(partNumber, stream.readable)])
      return new Response(null, { headers: { etag: part.etag } })
    } finally {
      controller.abort()
    }
  })

  app.openapi(completeUploadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const repository = new UploadedFileRepository(context.env.DB)
    const file = await repository.owned(context.req.valid('param').uploadId, actor.userId)
    if (!file) throw new ApiFault('attachment_not_found')
    if (file.etag) return context.body(null, 204)
    const { parts } = context.req.valid('json')
    if (
      parts.length !== Math.ceil(file.size / uploadPartSize(file.size)) ||
      parts.some((part, i) => part.partNumber !== i + 1)
    )
      throw new ApiFault('validation_failed')
    const bucket = attachmentBucket(context.env)
    // HEAD first recovers a lost response after R2 completed but before D1 did.
    const object =
      (await bucket.head(file.objectKey)) ??
      (await bucket.resumeMultipartUpload(file.objectKey, file.multipartId).complete(parts))
    if (object.size !== file.size) throw new ApiFault('validation_failed')
    await repository.complete(file.id, actor.userId, object.etag)
    return context.body(null, 204)
  })

  app.openapi(downloadSharedFileRoute, async (context) => {
    const file = await new UploadedFileRepository(context.env.DB).shared(
      context.req.valid('param').token,
    )
    if (!file) throw new ApiFault('attachment_not_found')
    return uploadedFileResponse(attachmentBucket(context.env), file, context.req.raw)
  })
}
