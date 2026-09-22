import {
  createUploadRoute,
  signUploadPartRoute,
  completeUploadRoute,
  downloadSharedFileRoute,
} from '@cloudflare-inbox/contracts'
import { UploadedFileRepository } from '@cloudflare-inbox/db'
import { sanitizeFilename, safeAttachmentContentType } from '@cloudflare-inbox/mail-core'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { requireActor, requireCookieMutationOrigin } from '../auth'
import { ApiFault } from '../http'
import {
  attachmentBucket,
  localUploads,
  presignPart,
  requireUploadConfiguration,
  uploadedFileResponse,
  uploadPartSize,
} from '../services/uploads'
import type { ApiDependencies, ApiEnv } from '../types'

export function registerUploadRoutes(
  app: OpenAPIHono<ApiEnv>,
  dependencies: ApiDependencies,
): void {
  app.openapi(createUploadRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    requireUploadConfiguration(context.env)
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

  app.openapi(signUploadPartRoute, async (context) => {
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const { uploadId, partNumber } = context.req.valid('param')
    const file = await new UploadedFileRepository(context.env.DB).owned(uploadId, actor.userId)
    if (!file) throw new ApiFault('attachment_not_found')
    if (file.etag || partNumber > Math.ceil(file.size / uploadPartSize(file.size)))
      throw new ApiFault('validation_failed')
    return context.json({ url: await presignPart(context.env, file, partNumber) }, 200)
  })

  // Wrangler's local R2 has no S3 endpoint. This adapter is restricted to a
  // loopback installation and repeats owner/CSRF checks on every part.
  app.put('/v1/uploads/:uploadId/parts/:partNumber/local', async (context) => {
    if (!localUploads(context.env)) throw new ApiFault('not_found')
    const actor = await requireActor(context.req.raw, context.env, dependencies, 'send')
    requireCookieMutationOrigin(context.req.raw, context.env, actor)
    const file = await new UploadedFileRepository(context.env.DB).owned(
      context.req.param('uploadId'),
      actor.userId,
    )
    const partNumber = Number(context.req.param('partNumber'))
    if (!file) throw new ApiFault('attachment_not_found')
    if (
      file.etag ||
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > Math.ceil(file.size / uploadPartSize(file.size)) ||
      !context.req.raw.body
    )
      throw new ApiFault('validation_failed')
    const part = await attachmentBucket(context.env)
      .resumeMultipartUpload(file.objectKey, file.multipartId)
      .uploadPart(partNumber, context.req.raw.body)
    return new Response(null, { headers: { etag: part.etag } })
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
