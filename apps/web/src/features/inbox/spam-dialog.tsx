import { useEffect, useId, useRef, useState } from 'react'
import type { Message } from '@cloudflare-inbox/contracts/messages'
import { CreateSpamRuleSchema, type CreateSpamRule } from '@cloudflare-inbox/contracts/spam'
import { Button } from '#/components/ui/button'
import { ApiRequestError } from './inbox-api'

export function SpamDialog({
  messages,
  onClose,
  onConfirm,
}: {
  messages: readonly Message[]
  onClose: () => void
  onConfirm: ((rule: CreateSpamRule) => Promise<void>) | undefined
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const submitting = useRef(false)
  const id = useId()
  const senders = [
    ...new Set(
      messages
        .filter((message) => message.direction === 'inbound')
        .map((message) => message.from.address.toLowerCase())
        .reverse(),
    ),
  ]
  const [sender, setSender] = useState(senders[0] ?? '')
  const [kind, setKind] = useState<'sender' | 'domain'>('sender')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const domain = sender.slice(sender.lastIndexOf('@') + 1)
  const rule = CreateSpamRuleSchema.safeParse({ kind, value: kind === 'sender' ? sender : domain })

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting.current) onClose()
      }}
      className="m-auto max-h-[90dvh] w-[min(92vw,28rem)] overflow-y-auto rounded-2xl border bg-background p-6 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (submitting.current || !rule.success || !onConfirm) return
          submitting.current = true
          setSaving(true)
          setError(null)
          try {
            await onConfirm(rule.data)
            onClose()
          } catch (cause) {
            setError(
              cause instanceof ApiRequestError
                ? cause.message
                : 'Could not save the spam blacklist. Try again.',
            )
          } finally {
            submitting.current = false
            setSaving(false)
          }
        }}
      >
        <h2 id={`${id}-title`} className="text-base font-semibold">
          Move to Spam and block sender
        </h2>
        <p id={`${id}-description`} className="text-sm text-muted-foreground">
          Move this conversation to Spam and choose which future mail to block. Matching mail will
          go to Spam without forwarding.
        </p>
        {senders.length > 1 ? (
          <label className="block space-y-2 text-sm">
            Sender to block
            <select
              className="h-9 w-full rounded-lg border bg-background px-2"
              disabled={saving}
              value={sender}
              onChange={(event) => setSender(event.currentTarget.value)}
            >
              {senders.map((address) => (
                <option key={address} value={address}>
                  {address}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <fieldset disabled={saving} className="space-y-2">
          <legend className="mb-2 text-sm font-medium">Block future mail from</legend>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm">
            <input
              className="mt-1 shrink-0"
              autoFocus
              type="radio"
              name={`${id}-kind`}
              value="sender"
              checked={kind === 'sender'}
              onChange={() => setKind('sender')}
            />
            <span className="min-w-0">
              <span className="block font-medium">This email address</span>
              <span className="block break-all text-muted-foreground">{sender}</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm">
            <input
              className="mt-1 shrink-0"
              type="radio"
              name={`${id}-kind`}
              value="domain"
              checked={kind === 'domain'}
              onChange={() => setKind('domain')}
            />
            <span className="min-w-0">
              <span className="block font-medium">Entire email domain</span>
              <span className="block break-all text-muted-foreground">{domain}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                Includes every sender at this domain and its subdomains.
              </span>
            </span>
          </label>
        </fieldset>
        <p className="text-xs text-muted-foreground">
          You can remove this rule later in General settings → Spam blacklist.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving || !rule.success || !onConfirm}>
            {saving ? 'Saving…' : 'Block and move to Spam'}
          </Button>
          <Button type="button" variant="ghost" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  )
}
