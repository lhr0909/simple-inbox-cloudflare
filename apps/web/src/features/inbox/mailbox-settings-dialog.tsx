import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import XIcon from 'lucide-react/dist/esm/icons/x.mjs'

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
  onUpdateMailbox,
  onBlockMailbox,
}: Readonly<{
  busy: boolean
  mailbox: InboxData['mailboxes'][number] | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdateMailbox?: InboxShellProps['onUpdateMailbox']
  onBlockMailbox?: InboxShellProps['onBlockMailbox']
}>) {
  const dialog = useRef<HTMLDialogElement>(null)
  const draftMailboxId = useRef(mailbox?.id ?? null)
  const preserveOpenDraft = useRef(false)
  const id = useId()
  const [alias, setAlias] = useState(mailbox?.senderAlias ?? '')
  const [whitelisted, setWhitelisted] = useState(mailbox?.whitelisted ?? false)
  const [forwardTo, setForwardTo] = useState(mailbox?.forwardTo ?? '')
  const [forwardHtml, setForwardHtml] = useState(mailbox?.forwardHtml ?? false)
  const [renderHtml, setRenderHtml] = useState(mailbox?.renderHtml ?? false)
  const [forwardToEdited, setForwardToEdited] = useState(false)
  const [blockStatus, setBlockStatus] = useState<'idle' | 'saving' | 'error'>('idle')
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

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
    setBlockStatus('idle')
    draftMailboxId.current = mailboxId
    preserveOpenDraft.current = false
    setWhitelisted(mailbox?.whitelisted ?? false)
    setAlias(mailbox?.senderAlias ?? '')
    setForwardTo(mailbox?.forwardTo ?? '')
    setForwardHtml(mailbox?.forwardHtml ?? false)
    setRenderHtml(mailbox?.renderHtml ?? false)
    setForwardToEdited(false)
    setStatus('idle')
  }, [
    mailbox?.whitelisted,
    mailbox?.forwardTo,
    mailbox?.id,
    mailbox?.senderAlias,
    mailbox?.forwardHtml,
    mailbox?.renderHtml,
    open,
  ])

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (mailbox === null || onUpdateMailbox === undefined) return
    const senderAlias = alias.trim() || null
    const patch: PatchMailboxRequest = {
      ...(whitelisted === mailbox.whitelisted ? {} : { whitelisted }),
      ...(forwardHtml === mailbox.forwardHtml ? {} : { forwardHtml }),
      ...(renderHtml === mailbox.renderHtml ? {} : { renderHtml }),
      ...(senderAlias === mailbox.senderAlias ? {} : { senderAlias }),
      ...(forwardToEdited ? { forwardTo: forwardTo.trim() || null } : {}),
    }
    if (Object.keys(patch).length === 0) {
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
      setForwardHtml(saved.forwardHtml)
      setRenderHtml(saved.renderHtml)
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
      className="m-auto max-h-[90dvh] overflow-y-auto w-[min(92vw,30rem)] rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/40"
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
              Choose sender, forwarding, and message display preferences for this mailbox.
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

        <label className="mt-5 flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={whitelisted && !mailbox?.blocked}
            disabled={busy || mailbox === null || mailbox.blocked}
            onChange={(event) => {
              setWhitelisted(event.currentTarget.checked)
              setStatus('idle')
            }}
          />
          <span>
            Show as an inbox
            <span className="block text-xs text-muted-foreground">
              {mailbox?.blocked
                ? 'Blocked mailboxes are hidden in Other inbound. Remove the mailbox blacklist rule in General settings to show this inbox again.'
                : 'Turning this off moves mail to Other inbound and disables forwarding.'}
            </span>
          </span>
        </label>
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

        <fieldset
          className="mt-5 space-y-4 border-t pt-4"
          disabled={busy || mailbox === null || status === 'saving'}
        >
          <legend className="text-sm font-medium">HTML email</legend>
          <label className="flex items-start gap-3">
            <input
              aria-describedby={`${id}-forward-html-help`}
              aria-labelledby={`${id}-forward-html-label`}
              checked={forwardHtml}
              className="mt-1 size-4 shrink-0 accent-primary"
              onChange={(event) => {
                setForwardHtml(event.currentTarget.checked)
                setStatus('idle')
              }}
              type="checkbox"
            />
            <span>
              <span className="text-sm font-medium" id={`${id}-forward-html-label`}>
                Forward full HTML
              </span>
              <span
                className="mt-1 block text-xs text-muted-foreground"
                id={`${id}-forward-html-help`}
              >
                Preserve original formatting and inline images in future forwarded emails. Your
                email client may load remote images and tracking pixels.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3">
            <input
              aria-describedby={`${id}-render-html-help`}
              aria-labelledby={`${id}-render-html-label`}
              checked={renderHtml}
              className="mt-1 size-4 shrink-0 accent-primary"
              onChange={(event) => {
                setRenderHtml(event.currentTarget.checked)
                setStatus('idle')
              }}
              type="checkbox"
            />
            <span>
              <span className="text-sm font-medium" id={`${id}-render-html-label`}>
                Display full HTML in inbox
              </span>
              <span
                className="mt-1 block text-xs text-muted-foreground"
                id={`${id}-render-html-help`}
              >
                Show formatting and images for retained emails. Remote images may reveal when you
                open a message. Scripts and forms stay blocked.
              </span>
            </span>
          </label>
        </fieldset>

        <section aria-label="Mailbox blocking" className="mt-5 space-y-3 border-t pt-4">
          <h3 className="text-sm font-semibold">Mailbox blocking</h3>
          <p className="text-xs text-muted-foreground">
            Hide this mailbox from the inbox list and send future incoming mail to Spam without
            forwarding. Existing messages stay unchanged and remain in Other inbound.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={
              busy ||
              mailbox === null ||
              mailbox.blocked ||
              !onBlockMailbox ||
              blockStatus === 'saving'
            }
            onClick={async () => {
              if (!mailbox || !onBlockMailbox || blockStatus === 'saving') return
              setBlockStatus('saving')
              try {
                await onBlockMailbox(mailbox.address)
                setBlockStatus('idle')
              } catch {
                setBlockStatus('error')
              }
            }}
          >
            {mailbox?.blocked
              ? 'Mailbox blocked'
              : blockStatus === 'saving'
                ? 'Blocking…'
                : 'Block mailbox'}
          </Button>
          {blockStatus === 'error' ? (
            <p role="alert" className="text-xs text-destructive">
              Could not finish blocking this mailbox. Try again.
            </p>
          ) : null}
        </section>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t pt-4">
          <Button disabled={busy || mailbox === null || status === 'saving'} type="submit">
            {status === 'saving' ? 'Saving…' : 'Save settings'}
          </Button>
          <Button onClick={() => onOpenChange(false)} type="button" variant="ghost">
            Cancel
          </Button>
          <span aria-live="polite" role="status" className="w-full text-xs text-muted-foreground">
            {status === 'saved' ? 'Settings saved.' : null}
            {status === 'error' ? 'Settings could not be saved.' : null}
          </span>
        </div>
      </form>
    </dialog>
  )
}
