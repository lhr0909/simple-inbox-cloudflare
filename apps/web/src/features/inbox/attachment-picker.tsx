import { RASTER_IMAGE_TYPE } from '@cloudflare-inbox/mail-core/render'
import { useEffect, useRef, useState } from 'react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { uploadAttachment } from './attachment-upload'

type Item = {
  key: string
  file: File
  progress: number
  downloadUrl?: string
  previewUrl: string
  id?: string
  error?: string
}

export function useAttachmentUploads() {
  const [items, setItems] = useState<Item[]>([])
  const previews = useRef(new Set<string>())
  const controllers = useRef(new Map<string, AbortController>())
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort()
      for (const url of previews.current) URL.revokeObjectURL(url)
    },
    [],
  )

  function start(item: Item) {
    const controller = new AbortController()
    controllers.current.set(item.key, controller)
    const update = (patch: Partial<Item>) =>
      setItems((current) =>
        current.map((value) => (value.key === item.key ? { ...value, ...patch } : value)),
      )
    void uploadAttachment(item.file, (progress) => update({ progress }), controller.signal)
      .then((session) => update({ ...session, progress: 100 }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          update({
            error: error instanceof Error ? error.message : 'Upload failed. Retry to continue.',
          })
      })
      .finally(() => controllers.current.delete(item.key))
  }
  return {
    items,
    files: items.map((item) => item.file),
    ids: items.flatMap((item) => (item.id ? [item.id] : [])),
    blocked: items.some((item) => !item.id),
    add(files: readonly File[]) {
      const added = files.map((file) => {
        const previewUrl = URL.createObjectURL(file)
        previews.current.add(previewUrl)
        return { file, key: crypto.randomUUID(), progress: 0, previewUrl }
      })
      setItems((current) => [...current, ...added])
      added.forEach(start)
    },
    remove(key: string) {
      controllers.current.get(key)?.abort()
      const previewUrl = items.find((item) => item.key === key)?.previewUrl
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl)
        previews.current.delete(previewUrl)
      }
      setItems((current) => current.filter((item) => item.key !== key))
    },
    retry(key: string) {
      const item = items.find((value) => value.key === key)
      if (!item) return
      const replacement = {
        key: item.key,
        file: item.file,
        previewUrl: item.previewUrl,
        progress: 0,
      }
      setItems((current) => current.map((value) => (value.key === key ? replacement : value)))
      start(replacement)
    },
    clear() {
      for (const controller of controllers.current.values()) controller.abort()
      for (const url of previews.current) URL.revokeObjectURL(url)
      previews.current.clear()
      setItems([])
    },
  }
}

export function AttachmentPicker({
  uploads,
  disabled,
  onChange,
  onInsert,
}: {
  uploads: ReturnType<typeof useAttachmentUploads>
  disabled: boolean
  onChange: () => void
  onInsert?: (id: string, filename: string, image: boolean) => void
}) {
  return (
    <div className="space-y-2">
      <Input
        aria-label="Add attachments"
        type="file"
        multiple
        disabled={disabled}
        onChange={(event) => {
          uploads.add(Array.from(event.currentTarget.files ?? []))
          event.currentTarget.value = ''
          onChange()
        }}
      />
      <p className="text-xs text-muted-foreground">
        Files are sent as download links. Anyone with a link can download.
      </p>
      {uploads.items.length ? (
        <ul aria-label="Attachments" className="space-y-2">
          {uploads.items.map((item) => (
            <li key={item.key} className="rounded-lg border p-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{item.file.name}</span>
                <span>{item.file.size.toLocaleString()} bytes</span>
                {item.error ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => uploads.retry(item.key)}
                  >
                    Retry
                  </Button>
                ) : null}
                <Button
                  aria-label={`Remove ${item.file.name}`}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={() => {
                    uploads.remove(item.key)
                    onChange()
                  }}
                >
                  Remove
                </Button>
              </div>
              {item.id && onInsert ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => onInsert(item.id!, item.file.name, false)}
                  >
                    Insert link
                  </Button>
                  {RASTER_IMAGE_TYPE.test(item.file.type) ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => onInsert(item.id!, item.file.name, true)}
                    >
                      Insert image
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <div aria-live="polite">
                {item.error ?? (item.id ? 'Ready to send' : `Uploading ${item.progress}%`)}
              </div>
              {!item.id && !item.error ? (
                <progress
                  className="h-1 w-full"
                  value={item.progress}
                  max={100}
                  aria-label={`Uploading ${item.file.name}`}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
