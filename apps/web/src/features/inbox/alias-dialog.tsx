import { useEffect, useRef, useState, useId } from 'react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import type { InboxShellProps } from './inbox-shell-types'

export function AliasDialog({
  open,
  initialAddress = '',
  onOpenChange,
  onCreateMailbox,
}: {
  open: boolean
  initialAddress?: string
  onOpenChange: (open: boolean) => void
  onCreateMailbox?: InboxShellProps['onCreateMailbox']
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [address, setAddress] = useState('')
  const [forwardTo, setForwardTo] = useState('')
  const helpId = useId()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      dialog.current?.showModal()
      setError(null)
      setAddress(initialAddress)
      setForwardTo('')
    } else dialog.current?.close()
  }, [open, initialAddress])
  return (
    <dialog
      ref={dialog}
      aria-label="New inbox"
      onCancel={() => onOpenChange(false)}
      onClose={() => onOpenChange(false)}
      className="m-auto w-[min(92vw,28rem)] rounded-2xl border bg-background p-6 text-foreground shadow-2xl backdrop:bg-black/40"
    >
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!onCreateMailbox) return
          setSaving(true)
          setError(null)
          try {
            await onCreateMailbox(address.trim(), forwardTo.trim() || null)
            setAddress('')
            onOpenChange(false)
          } catch {
            setError(
              'Could not create inbox. Use an address on a domain already receiving your mail.',
            )
          } finally {
            setSaving(false)
          }
        }}
      >
        <h2 className="text-base font-semibold">New inbox</h2>
        <p className="text-sm text-muted-foreground">
          Create a mailbox on your routed domain, or promote one that has already received mail.
        </p>
        <label className="block space-y-2 text-sm">
          Email address
          <Input
            autoFocus
            required
            type="email"
            value={address}
            onChange={(e) => setAddress(e.currentTarget.value)}
            placeholder="team@example.test"
          />
        </label>
        <label className="block space-y-2 text-sm">
          Forward incoming mail to
          <Input
            type="email"
            autoComplete="email"
            maxLength={254}
            aria-describedby={helpId}
            value={forwardTo}
            disabled={saving}
            onChange={(event) => setForwardTo(event.currentTarget.value)}
            placeholder="you@example.test"
          />
        </label>
        <p id={helpId} className="text-xs text-muted-foreground">
          Leave empty to keep mail in this inbox without forwarding.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button disabled={saving} type="submit">
            {saving ? 'Creating…' : 'Create inbox'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </dialog>
  )
}
