import { useEffect, useRef, useState, type ReactNode } from 'react'

import { Button } from '#/components/ui/button'

export function HtmlMessageBody({
  messageId,
  text,
  renderFooter,
}: Readonly<{ messageId: string; text: string; renderFooter: (toggle: ReactNode) => ReactNode }>) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [showText, setShowText] = useState(false)
  const [failed, setFailed] = useState(false)
  const [height, setHeight] = useState(400)

  useEffect(() => {
    function receive(event: MessageEvent<unknown>) {
      if (event.source !== frame.current?.contentWindow || event.origin !== 'null') return
      const data = event.data as { type?: unknown; ok?: unknown; height?: unknown } | null
      if (data?.type !== 'simple-inbox-html' || typeof data.ok !== 'boolean') return
      if (!data.ok) setFailed(true)
      if (typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.min(1_200, Math.max(160, data.height)))
      }
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  return (
    <div>
      {showText || failed ? (
        <div className="whitespace-pre-wrap p-4 text-sm leading-6">{text}</div>
      ) : (
        <iframe
          className="block w-full border-0 bg-white"
          loading="lazy"
          onError={() => setFailed(true)}
          ref={frame}
          referrerPolicy="no-referrer"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
          src={`/api/v1/messages/${encodeURIComponent(messageId)}/html`}
          style={{ height }}
          title="HTML email"
        />
      )}
      {failed ? (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          HTML is unavailable. Showing plain text.
        </p>
      ) : null}
      {renderFooter(
        failed ? null : (
          <Button onClick={() => setShowText((value) => !value)} size="sm" variant="ghost">
            {showText ? 'Show HTML' : 'Show plain text'}
          </Button>
        ),
      )}
    </div>
  )
}
