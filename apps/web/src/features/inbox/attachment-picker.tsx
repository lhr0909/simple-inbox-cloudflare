import { useEffect, useRef, useState } from 'react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { uploadAttachment } from './attachment-upload'

type Item = { key: string; file: File; progress: number; id?: string; error?: string }

export function useAttachmentUploads() {
  const [items, setItems] = useState<Item[]>([])
  const controllers = useRef(new Map<string, AbortController>())
  useEffect(
    () => () => {
      for (const controller of controllers.current.values()) controller.abort()
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
      .then((id) => update({ id, progress: 100 }))
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
      const added = files.map((file) => ({ file, key: crypto.randomUUID(), progress: 0 }))
      setItems((current) => [...current, ...added])
      added.forEach(start)
    },
    remove(key: string) {
      controllers.current.get(key)?.abort()
      setItems((current) => current.filter((item) => item.key !== key))
    },
    retry(key: string) {
      const item = items.find((value) => value.key === key)
      if (!item) return
      const replacement = { key: item.key, file: item.file, progress: 0 }
      setItems((current) => current.map((value) => (value.key === key ? replacement : value)))
      start(replacement)
    },
    clear() {
      for (const controller of controllers.current.values()) controller.abort()
      setItems([])
    },
  }
}

export function AttachmentPicker({
  uploads,
  disabled,
  onChange,
}: {
  uploads: ReturnType<typeof useAttachmentUploads>
  disabled: boolean
  onChange: () => void
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
