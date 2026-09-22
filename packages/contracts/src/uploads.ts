import { z } from '@hono/zod-openapi'
import { FileNameSchema, MediaTypeSchema } from './primitives'
import { AttachmentIdSchema } from './ids'

export const CreateUploadSchema = z
  .object({
    filename: FileNameSchema,
    mediaType: MediaTypeSchema,
    size: z.number().int().nonnegative().safe(),
  })
  .strict()
  .openapi('CreateUpload')
export const UploadSessionSchema = z
  .object({
    id: AttachmentIdSchema,
    partSize: z.number().int().positive(),
    complete: z.boolean(),
  })
  .strict()
  .openapi('UploadSession')
export const CompleteUploadSchema = z
  .object({
    parts: z.array(
      z
        .object({
          partNumber: z.number().int().min(1).max(10_000),
          etag: z.string().min(1).max(256),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi('CompleteUpload')

export type CreateUpload = z.infer<typeof CreateUploadSchema>
export type UploadSession = z.infer<typeof UploadSessionSchema>
export type CompleteUpload = z.infer<typeof CompleteUploadSchema>
