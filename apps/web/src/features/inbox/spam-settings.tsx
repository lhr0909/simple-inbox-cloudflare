import { useEffect, useState } from 'react'
import type { CreateSpamRule, SpamRulesResponse } from '@cloudflare-inbox/contracts/spam'
import { SpamRulesResponseSchema } from '@cloudflare-inbox/contracts/spam'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

export function SpamSettings({
  open,
  onRulesChange,
}: {
  open: boolean
  onRulesChange?: (() => Promise<void>) | undefined
}) {
  const [rules, setRules] = useState<SpamRulesResponse['rules']>([])
  const [kind, setKind] = useState<CreateSpamRule['kind']>('recipient')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function load(signal?: AbortSignal) {
    const response = await fetch('/api/v1/spam-rules', {
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    })
    if (!response.ok) throw new Error('Could not load blacklist.')
    setRules(SpamRulesResponseSchema.parse(await response.json()).rules)
  }
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted)
        setError('Could not load blacklist. Close settings and try again.')
    })
    return () => controller.abort()
  }, [open])
  async function mutate(id?: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        id ? `/api/v1/spam-rules/${encodeURIComponent(id)}` : '/api/v1/spam-rules',
        {
          method: id ? 'DELETE' : 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          ...(id ? {} : { body: JSON.stringify({ kind, value: value.trim() }) }),
        },
      )
      if (!response.ok) throw new Error('Invalid rule')
      if (!id) setValue('')
      await load()
      await onRulesChange?.()
    } catch {
      setError('Could not save blacklist. Check the address or domain and try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="mt-5 space-y-3 border-t pt-4" aria-label="Spam blacklist">
      <h3 className="text-sm font-semibold">Spam blacklist</h3>
      <p className="text-xs text-muted-foreground">
        Matching future mail goes to Spam and is never forwarded. Domain rules include subdomains.
        Existing mail is unchanged.
      </p>
      <label className="block text-sm">
        Block by
        <select
          aria-label="Blacklist type"
          className="mt-1 h-9 w-full rounded-lg border bg-background px-2"
          value={kind}
          onChange={(e) => setKind(e.currentTarget.value as CreateSpamRule['kind'])}
        >
          <option value="recipient">Mailbox</option>
          <option value="sender">Sender address</option>
          <option value="domain">Sender domain</option>
        </select>
      </label>
      <label className="block text-sm">
        {kind === 'domain' ? 'Domain' : 'Email address'}
        <Input
          aria-label="Blacklist value"
          className="mt-1"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={kind === 'domain' ? 'sender.example.test' : 'unused@example.test'}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void mutate()
            }
          }}
        />
      </label>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || !value.trim()}
        onClick={() => void mutate()}
      >
        Add to blacklist
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <ul className="max-h-48 space-y-2 overflow-y-auto">
        {rules.map((rule) => (
          <li key={rule.id} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 break-all">
              <span className="text-muted-foreground">
                {rule.kind === 'recipient'
                  ? 'Mailbox'
                  : rule.kind === 'sender'
                    ? 'Sender'
                    : 'Domain'}{' '}
                ·{' '}
              </span>
              {rule.value}
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              aria-label={`Remove ${rule.value} from blacklist`}
              onClick={() => void mutate(rule.id)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
      {rules.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">No blacklist rules.</p>
      ) : null}
    </section>
  )
}
