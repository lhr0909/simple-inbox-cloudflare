import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import LogOutIcon from 'lucide-react/dist/esm/icons/log-out.mjs'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'
import { useTheme } from 'fumadocs-ui/provider/base'

import type { PatchMailboxRequest } from '@cloudflare-inbox/contracts/mailboxes'

import { Button } from '#/components/ui/button'
import { Field, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'

import type { InboxData } from './inbox-types'

import type { InboxShellProps } from './inbox-shell-types'

export function MailboxSettingsDialog({
  busy,
  mailbox,
  open,
  onOpenChange,
  onSignOut,
  onUpdateMailbox,
}: Readonly<{
  busy: boolean
  mailbox: InboxData['mailboxes'][number] | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSignOut?: InboxShellProps['onSignOut']
  onUpdateMailbox?: InboxShellProps['onUpdateMailbox']
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const draftMailboxId = useRef(mailbox?.id ?? null)
  const preserveOpenDraft = useRef(false)
  const id = useId()
  const [alias, setAlias] = useState(mailbox?.senderAlias ?? '')
  const [forwardTo, setForwardTo] = useState(mailbox?.forwardTo ?? '')
  const [forwardToEdited, setForwardToEdited] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const { setTheme, theme } = useTheme()
  const selectedTheme = theme === 'light' || theme === 'dark' ? theme : 'system'

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  useEffect(() => {
    if (!open) {
      preserveOpenDraft.current = false
      return
    }
    const mailboxId = mailbox?.id ?? null
    const mailboxChanged = draftMailboxId.current !== mailboxId
    if (!mailboxChanged && preserveOpenDraft.current) return
    draftMailboxId.current = mailboxId
    preserveOpenDraft.current = false
    setAlias(mailbox?.senderAlias ?? '')
    setForwardTo(mailbox?.forwardTo ?? '')
    setForwardToEdited(false)
    setStatus('idle')
  }, [mailbox?.forwardTo, mailbox?.id, mailbox?.senderAlias, open])

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (mailbox === null || onUpdateMailbox === undefined) return
    const senderAlias = alias.trim() || null
    const patch: PatchMailboxRequest = {
      ...(senderAlias === mailbox.senderAlias ? {} : { senderAlias }),
      ...(forwardToEdited ? { forwardTo: forwardTo.trim() || null } : {}),
    }
    if (patch.senderAlias === undefined && patch.forwardTo === undefined) {
      preserveOpenDraft.current = true
      setStatus('saved')
      return
    }
    // Parent state may publish the saved mailbox before this promise resumes.
    // Preserve this open dialog's status/draft across that same-mailbox update;
    // closing the dialog clears the guard so the next open uses fresh props.
    preserveOpenDraft.current = true
    setStatus('saving')
    try {
      const saved = await onUpdateMailbox(mailbox.id, patch)
      setAlias(saved.senderAlias ?? '')
      setForwardTo(saved.forwardTo ?? '')
      setForwardToEdited(false)
      setStatus('saved')
    } catch {
      setStatus('error')
    }
  }

  return (
    <dialog
      aria-describedby={`${id}-description`}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(92vw,30rem)] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault()
        onOpenChange(false)
      }}
      onClose={() => onOpenChange(false)}
      ref={dialog}
    >
      <form className="p-5 sm:p-6" onSubmit={(event) => void save(event)}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold" id={`${id}-title`}>
              Mailbox settings
            </h2>
            <p className="mt-1 text-sm text-muted-foreground" id={`${id}-description`}>
              Update the outbound sender name and inbound forwarding destination for this mailbox.
            </p>
          </div>
          <Button
            aria-label="Close settings"
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <Field className="mt-5">
          <FieldLabel htmlFor={`${id}-alias`}>Sender alias</FieldLabel>
          <Input
            autoFocus
            disabled={busy || mailbox === null}
            id={`${id}-alias`}
            maxLength={200}
            onChange={(event) => {
              setAlias(event.currentTarget.value)
              setStatus('idle')
            }}
            placeholder={mailbox?.address ?? 'Mailbox sender'}
            value={alias}
          />
          <p className="text-xs text-muted-foreground">
            Mailbox: {mailbox?.address ?? 'No mailbox assigned'}
          </p>
        </Field>

        <Field className="mt-4">
          <FieldLabel htmlFor={`${id}-forward-to`}>Forward inbound mail to</FieldLabel>
          <Input
            autoComplete="email"
            disabled={busy || mailbox === null}
            id={`${id}-forward-to`}
            inputMode="email"
            maxLength={254}
            onChange={(event) => {
              setForwardTo(event.currentTarget.value)
              setForwardToEdited(true)
              setStatus('idle')
            }}
            placeholder="owner@example.com"
            type="email"
            value={forwardTo}
          />
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {forwardToEdited
                ? 'This destination will be updated when you save.'
                : 'The current forwarding destination will remain unchanged.'}
            </span>
            {forwardToEdited ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setForwardTo(mailbox?.forwardTo ?? '')
                  setForwardToEdited(false)
                  setStatus('idle')
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Keep current
              </Button>
            ) : null}
            {mailbox?.forwardTo !== null ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setForwardTo('')
                  setForwardToEdited(true)
                  setStatus('idle')
                }}
                size="xs"
                type="button"
                variant="ghost"
              >
                Clear forwarding
              </Button>
            ) : null}
          </div>
        </Field>

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

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button disabled={busy || mailbox === null || status === 'saving'} type="submit">
            {status === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            className="ml-auto"
            disabled={busy}
            onClick={() => void onSignOut?.()}
            type="button"
            variant="ghost"
          >
            <LogOutIcon aria-hidden="true" className="size-4" />
            Sign out
          </Button>
          <span aria-live="polite" className="w-full text-xs text-muted-foreground">
            {status === 'saved' ? 'Sender alias saved.' : null}
            {status === 'error' ? 'Settings could not be saved.' : null}
          </span>
        </div>
      </form>
    </dialog>
  )
}
