import { UploadSessionSchema } from '@cloudflare-inbox/contracts/uploads'

async function jsonRequest(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok)
    throw new Error(
      response.status === 503
        ? 'Attachment storage is not configured. See the deployment guide.'
        : 'Upload failed. Retry to continue.',
    )
  return response.status === 204 ? null : response.json()
}

export async function uploadAttachment(
  file: File,
  progress: (percent: number) => void = () => {},
  signal?: AbortSignal,
): Promise<{ id: string; downloadUrl: string }> {
  const session = UploadSessionSchema.parse(
    await jsonRequest(
      '/api/v1/uploads',
      {
        filename: file.name,
        mediaType: file.type || 'application/octet-stream',
        size: file.size,
      },
      signal,
    ),
  )
  if (session.complete) {
    progress(100)
    return { id: session.id, downloadUrl: session.downloadUrl }
  }
  const parts: Array<{ partNumber: number; etag: string }> = []
  for (let offset = 0; offset < file.size; offset += session.partSize) {
    const partNumber = parts.length + 1
    const part = file.slice(offset, offset + session.partSize)
    // Retry the same part through the authenticated Worker; R2 replaces it atomically.
    let etag: string | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        etag = await putPart(
          `/api/v1/uploads/${session.id}/parts/${partNumber}`,
          part,
          (loaded) => progress(Math.min(99, Math.floor(((offset + loaded) / file.size) * 100))),
          signal,
        )
        break
      } catch (error) {
        if (signal?.aborted || attempt === 2) throw error
      }
    }
    if (!etag) throw new Error('Storage did not return an upload receipt. Retry to continue.')
    parts.push({ partNumber, etag })
  }
  await jsonRequest(`/api/v1/uploads/${session.id}/complete`, { parts }, signal)
  progress(100)
  return { id: session.id, downloadUrl: session.downloadUrl }
}

function putPart(
  url: string,
  body: Blob,
  progress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    const cleanup = () => signal?.removeEventListener('abort', abort)
    request.open('PUT', url)
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.onprogress = (event) => progress(event.loaded)
    request.onload = () => {
      cleanup()
      const etag = request.getResponseHeader('etag')?.replace(/^"|"$/gu, '')
      if (request.status >= 200 && request.status < 300 && etag) resolve(etag)
      else reject(new Error('Upload failed. Retry to continue.'))
    }
    request.onerror = () => {
      cleanup()
      reject(new Error('Upload failed. Check your connection and retry.'))
    }
    request.onabort = () => {
      cleanup()
      reject(new DOMException('Upload cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      cleanup()
      reject(new DOMException('Upload cancelled', 'AbortError'))
      return
    }
    request.send(body)
  })
}
