import { UploadedFileRepository, type UploadedFile } from '@cloudflare-inbox/db'
import {
  appendEmailAttachmentLinks,
  MAX_MESSAGE_PROJECTION_BODY_BYTES,
  messageProjectionBodyBytes,
  type RenderedMessageContent,
} from '@cloudflare-inbox/mail-core'
import { MailFault } from '../errors'
import type { MailBindings } from '../types'

export async function resolveLinkedAttachments(
  ids: readonly string[],
  userId: string,
  env: MailBindings,
): Promise<UploadedFile[]> {
  const repository = new UploadedFileRepository(env.DB)
  const files: UploadedFile[] = []
  for (const id of ids) {
    const file = await repository.owned(id, userId)
    if (!file || !file.etag) throw new MailFault('attachment_not_found', 404)
    const object = await env.STORAGE?.head(file.objectKey)
    if (!object || object.etag !== file.etag || object.size !== file.size)
      throw new MailFault('attachment_not_found', 404)
    files.push(file)
  }
  return files
}

export function appendLinkedAttachments(
  content: RenderedMessageContent,
  files: readonly UploadedFile[],
  origin: string,
): RenderedMessageContent {
  const links = files.map((file) => ({
    ...file,
    url: `${origin}/api/v1/downloads/${file.downloadToken}`,
  }))
  const result = appendEmailAttachmentLinks(content, links)
  if (
    messageProjectionBodyBytes(result) > MAX_MESSAGE_PROJECTION_BODY_BYTES ||
    result.text.length > 1_000_000
  )
    throw new MailFault('request_too_large', 413)
  return result
}
