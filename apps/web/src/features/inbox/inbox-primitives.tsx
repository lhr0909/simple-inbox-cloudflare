import { createContext, useContext, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import ClockIcon from 'lucide-react/dist/esm/icons/clock-3.mjs'
import InboxIcon from 'lucide-react/dist/esm/icons/inbox.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import TagIcon from 'lucide-react/dist/esm/icons/tag.mjs'

import { cn } from '#/lib/utils'

import { clampPaneSize, formatMessageTime } from './inbox-model'

export const HydratedTimeContext = createContext(false)

export function BrandMark() {
  return (
    <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
      <MailOpenIcon aria-hidden="true" className="size-4" />
    </div>
  )
}

type TimePresentation = 'date' | 'full' | 'thread'

export function HydratedTime({
  className,
  presentation,
  value,
}: Readonly<{ className?: string; presentation: TimePresentation; value: string }>) {
  const localTimesReady = useContext(HydratedTimeContext)

  return (
    <time className={className} dateTime={value} suppressHydrationWarning>
      {formatTime(value, presentation, localTimesReady)}
    </time>
  )
}

export function formatTime(
  value: string,
  presentation: TimePresentation,
  localTimesReady: boolean,
): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value

  if (!localTimesReady) {
    const iso = date.toISOString()
    return presentation === 'full' ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : iso.slice(0, 10)
  }

  switch (presentation) {
    case 'thread':
      return formatMessageTime(value)
    case 'date':
      return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date)
    case 'full':
      return new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
  }
}

export function EmptyList({
  title,
  description,
}: Readonly<{ title: string; description: string }>) {
  return (
    <div className="flex h-full min-h-52 flex-col items-center justify-center px-8 text-center">
      <InboxIcon aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="mt-1 max-w-60 text-sm text-muted-foreground">{description}</p>
    </div>
  )
}

export function PaneResizeHandle({
  className,
  disabled = false,
  label,
  maximum,
  minimum,
  onChange,
  value,
}: Readonly<{
  className?: string
  disabled?: boolean
  label: string
  maximum: number
  minimum: number
  onChange: (value: number) => void
  value: number
}>) {
  const drag = useRef<{ pointerId: number; start: number; value: number } | null>(null)

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (disabled) return
    drag.current = { pointerId: event.pointerId, start: event.clientX, value }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return
    onChange(
      clampPaneSize(drag.current.value + event.clientX - drag.current.start, minimum, maximum),
    )
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  function keyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (disabled) return
    let next = value
    if (event.key === 'ArrowLeft') next -= 16
    else if (event.key === 'ArrowRight') next += 16
    else if (event.key === 'Home') next = minimum
    else if (event.key === 'End') next = maximum
    else return
    event.preventDefault()
    onChange(clampPaneSize(next, minimum, maximum))
  }

  return (
    <div
      aria-disabled={disabled || undefined}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={value}
      className={cn(
        'relative z-10 cursor-col-resize bg-border outline-none transition-colors after:absolute after:inset-y-0 after:-left-1 after:w-3 hover:bg-primary focus-visible:bg-primary',
        disabled && 'cursor-default opacity-50',
        className,
      )}
      onKeyDown={keyDown}
      onPointerCancel={pointerUp}
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      role="separator"
      tabIndex={disabled ? -1 : 0}
    />
  )
}

export function InboxStatusLegend() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <TagIcon aria-hidden="true" className="size-3" />
        Needs reply
      </span>
      <span className="inline-flex items-center gap-1">
        <ClockIcon aria-hidden="true" className="size-3" />
        Waiting
      </span>
    </div>
  )
}
