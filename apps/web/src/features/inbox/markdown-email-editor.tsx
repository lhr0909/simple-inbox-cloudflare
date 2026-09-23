import { useId, useMemo, useRef, useState } from 'react'
import { RASTER_IMAGE_TYPE, renderSafeMessageContent } from '@cloudflare-inbox/mail-core/render'
import {
  EMAIL_PREVIEW_CSS,
  appendEmailAttachmentLinks,
  presentEmailHtml,
} from '@cloudflare-inbox/mail-core/email-presentation'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import { AttachmentPicker, type useAttachmentUploads } from './attachment-picker'

type Uploads = ReturnType<typeof useAttachmentUploads>

export function useEmailPreview(body: string, uploads: Uploads) {
  return useMemo(() => {
    const attachments = uploads.items.flatMap((item) =>
      item.id
        ? [
            {
              id: item.id,
              filename: item.file.name,
              size: item.file.size,
              url: item.downloadUrl!,
              ...(RASTER_IMAGE_TYPE.test(item.file.type) ? { imageUrl: item.previewUrl } : {}),
            },
          ]
        : [],
    )
    try {
      const content = renderSafeMessageContent({ source: 'app', markdown: body, attachments })
      const complete = appendEmailAttachmentLinks(
        { ...content, html: presentEmailHtml(content.html) },
        attachments,
      )
      return { ...complete, error: null }
    } catch {
      return {
        text: '',
        html: '',
        error:
          'An inserted attachment is missing or cannot be shown as an image. Remove its reference or attach and insert it again.',
      }
    }
  }, [body, uploads.items])
}

export function MarkdownEmailEditor({
  id,
  value,
  onChange,
  uploads,
  preview,
  disabled,
  autoFocus = false,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  uploads: Uploads
  preview: ReturnType<typeof useEmailPreview>
  disabled: boolean
  autoFocus?: boolean
}) {
  const tabsId = useId()
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [tab, setTab] = useState<'write' | 'preview' | 'text'>('write')
  const tabs = ['write', 'preview', 'text'] as const
  function insert(before: string, after = '', placeholder = '', select = true) {
    const start = textarea.current?.selectionStart ?? value.length
    const end = textarea.current?.selectionEnd ?? value.length
    const selected = value.slice(start, end) || placeholder
    onChange(value.slice(0, start) + before + selected + after + value.slice(end))
    setTab('write')
    requestAnimationFrame(() => {
      textarea.current?.focus()
      const cursor = start + before.length + selected.length + after.length
      textarea.current?.setSelectionRange(
        select ? start + before.length : cursor,
        select ? start + before.length + selected.length : cursor,
      )
    })
  }
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src blob: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>${EMAIL_PREVIEW_CSS}</style></head><body>${preview.html}</body></html>`
  return (
    <div className="min-w-0 space-y-3">
      <div className="overflow-hidden rounded-lg border bg-background">
        <div
          role="tablist"
          aria-label="Email editor"
          className="flex gap-1 border-b bg-muted/40 p-1"
        >
          {tabs.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${tabsId}-${name}`}
              aria-controls={`${tabsId}-panel`}
              aria-selected={tab === name}
              tabIndex={tab === name ? 0 : -1}
              className="rounded-md px-3 py-1.5 text-sm aria-selected:bg-background aria-selected:font-medium aria-selected:shadow-xs"
              onClick={() => setTab(name)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
                setTab(tabs[next]!)
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus()
              }}
            >
              {name === 'write' ? 'Write' : name === 'preview' ? 'Preview' : 'Plain text'}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`}>
          {tab === 'write' ? (
            <>
              <div className="flex flex-wrap gap-1 border-b p-1.5" aria-label="Formatting">
                {[
                  ['Bold', '**', '**', 'bold text'],
                  ['Italic', '*', '*', 'italic text'],
                  ['Heading', '\n## ', '\n', 'Heading'],
                  ['List', '\n- ', '\n', 'List item'],
                  ['Link', '[', '](https://example.com)', 'link text'],
                  ['Code', '`', '`', 'code'],
                ].map(([label, before, after, placeholder]) => (
                  <Button
                    key={label}
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(before!, after, placeholder)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <label className="sr-only" htmlFor={id}>
                Message
              </label>
              <Textarea
                ref={textarea}
                id={id}
                value={value}
                autoFocus={autoFocus}
                disabled={disabled}
                required
                onChange={(event) => onChange(event.currentTarget.value)}
                placeholder="Write your message in Markdown…"
                className="min-h-48 resize-y rounded-none border-0 shadow-none focus-visible:ring-inset"
              />
              <p className="px-3 pb-2 text-xs text-muted-foreground">
                Markdown supported. Upload files below to insert links and images.
              </p>
            </>
          ) : tab === 'preview' ? (
            <iframe
              title="Email preview"
              sandbox="allow-same-origin"
              referrerPolicy="no-referrer"
              srcDoc={document}
              className="block h-96 w-full border-0 bg-white"
            />
          ) : (
            <pre className="min-h-48 whitespace-pre-wrap break-words p-4 font-sans text-sm leading-6">
              {preview.text || 'Your plain-text email will appear here.'}
            </pre>
          )}
        </div>
      </div>
      {preview.error ? (
        <p role="alert" className="text-sm text-destructive">
          {preview.error}
        </p>
      ) : null}
      <AttachmentPicker
        uploads={uploads}
        disabled={disabled}
        onChange={() => onChange(value)}
        onInsert={(uploadId, filename, image) => {
          const label = filename.replace(/[[\]\r\n]/gu, ' ').trim() || 'Attachment'
          insert(
            image ? '\n![' : '[',
            `](attachment:${uploadId})${image ? '\n' : ''}`,
            label,
            false,
          )
        }}
      />
    </div>
  )
}
