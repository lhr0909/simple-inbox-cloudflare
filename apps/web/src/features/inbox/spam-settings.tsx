import { useEffect, useState } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import type { CreateSpamRule, SpamRulesResponse } from '@cloudflare-inbox/contracts/spam'
import { SpamRulesResponseSchema } from '@cloudflare-inbox/contracts/spam'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

const FILTERS = [
  { value: 'all', label: 'All', empty: 'No blacklist rules.' },
  { value: 'domain', label: 'Domains', empty: 'No blocked domains.' },
  { value: 'recipient', label: 'Mailboxes', empty: 'No blocked mailboxes.' },
  { value: 'sender', label: 'Email addresses', empty: 'No blocked sender email addresses.' },
] as const

type RuleFilter = (typeof FILTERS)[number]['value']

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
  const [filter, setFilter] = useState<RuleFilter>('all')
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
      if (!id) setFilter((current) => (current === 'all' ? current : kind))
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
      <Tabs.Root value={filter} onValueChange={(next) => setFilter(next as RuleFilter)}>
        <Tabs.List
          aria-label="Blacklist categories"
          className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-[auto_auto_auto_auto]"
        >
          {FILTERS.map((tab) => (
            <Tabs.Tab
              key={tab.value}
              value={tab.value}
              className="flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs whitespace-nowrap outline-none data-active:bg-background data-active:font-medium data-active:shadow-xs focus-visible:ring-2 focus-visible:ring-ring"
            >
              {tab.label}
              <span className="text-muted-foreground tabular-nums">
                {tab.value === 'all'
                  ? rules.length
                  : rules.filter((rule) => rule.kind === tab.value).length}
              </span>
            </Tabs.Tab>
          ))}
        </Tabs.List>
        {FILTERS.map((tab) => {
          const visibleRules =
            tab.value === 'all' ? rules : rules.filter((rule) => rule.kind === tab.value)
          return (
            <Tabs.Panel
              key={tab.value}
              value={tab.value}
              className="pt-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ul className="max-h-48 space-y-2 overflow-y-auto">
                {visibleRules.map((rule) => (
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
              {visibleRules.length === 0 && !error ? (
                <p className="text-xs text-muted-foreground">{tab.empty}</p>
              ) : null}
            </Tabs.Panel>
          )
        })}
      </Tabs.Root>
    </section>
  )
}
