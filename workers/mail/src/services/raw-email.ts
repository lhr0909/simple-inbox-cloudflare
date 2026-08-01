import { MAX_INBOUND_BYTES, sha256Hex } from '@cloudflare-inbox/mail-core'

import { MailFault } from '../errors'

export type StoredRawMessage = {
  bytes: Uint8Array
  key: string
  sha256: string
  size: number
}

export async function readInboundRaw(
  raw: ReadableStream<Uint8Array>,
  declaredSize: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
    throw new MailFault('validation_failed', 400)
  }
  if (declaredSize > MAX_INBOUND_BYTES) {
    throw new MailFault('request_too_large', 413)
  }

  const reader = raw.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      total += value.byteLength
      if (total > MAX_INBOUND_BYTES) {
        await reader.cancel('Inbound message exceeds the size limit.')
        throw new MailFault('request_too_large', 413)
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  if (total !== declaredSize) {
    throw new MailFault('validation_failed', 400, {
      details: { reason: 'raw_size_mismatch' },
    })
  }
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

export async function putRawMessage(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  direction: 'inbound' | 'outbound',
): Promise<{ sha256: string; size: number }> {
  const sha256 = await sha256Hex(bytes)
  await bucket.put(key, bytes, {
    customMetadata: { direction, sha256 },
    httpMetadata: { contentType: 'message/rfc822' },
  })
  return { sha256, size: bytes.byteLength }
}

export async function putInboundRaw(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  sha256: string,
): Promise<void> {
  await bucket.put(key, bytes, {
    customMetadata: { direction: 'inbound', sha256 },
    httpMetadata: { contentType: 'message/rfc822' },
  })
}
