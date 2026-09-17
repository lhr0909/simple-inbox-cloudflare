import { useEffect, useId, useRef } from 'react'
import { useTheme } from 'fumadocs-ui/provider/base'
import LogOutIcon from 'lucide-react/dist/esm/icons/log-out.mjs'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'
import { Button } from '#/components/ui/button'
import { Field, FieldLabel } from '#/components/ui/field'
import { SpamSettings } from './spam-settings'
import type { InboxShellProps } from './inbox-shell-types'

export function GeneralSettingsDialog({
  open,
  onOpenChange,
  onSignOut,
  onSpamRulesChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSignOut?: InboxShellProps['onSignOut']
  onSpamRulesChange?: InboxShellProps['onSpamRulesChange']
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const id = useId()
  const { setTheme, theme } = useTheme()
  const selectedTheme = theme === 'light' || theme === 'dark' ? theme : 'system'
  useEffect(() => {
    const element = dialog.current
    if (open && !element?.open) element?.showModal()
    if (!open && element?.open) element.close()
  }, [open])
  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault()
        onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      className="m-auto max-h-[90dvh] w-[min(92vw,30rem)] overflow-y-auto rounded-2xl border bg-background p-5 text-foreground shadow-2xl backdrop:bg-black/40 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id={`${id}-title`} className="text-base font-semibold">
            General settings
          </h2>
          <p id={`${id}-description`} className="mt-1 text-sm text-muted-foreground">
            Manage appearance and spam rules shared across all your inboxes.
          </p>
        </div>
        <Button
          aria-label="Close general settings"
          onClick={() => onOpenChange(false)}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      </div>
      <Field className="mt-4">
        <FieldLabel htmlFor={`${id}-theme`}>Color theme</FieldLabel>
        <select
          className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          id={`${id}-theme`}
          onChange={(event) => setTheme(event.currentTarget.value)}
          value={selectedTheme}
        >
          <option value="system">Use system setting</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
        <p className="text-xs text-muted-foreground">
          Your preference is kept in this browser for the inbox and documentation.
        </p>
      </Field>

      <SpamSettings open={open} onRulesChange={onSpamRulesChange} />
      <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-4">
        <Button onClick={() => onOpenChange(false)}>Done</Button>
        <Button className="ml-auto" variant="ghost" onClick={() => void onSignOut?.()}>
          <LogOutIcon aria-hidden="true" className="size-4" />
          Sign out
        </Button>
      </div>
    </dialog>
  )
}
