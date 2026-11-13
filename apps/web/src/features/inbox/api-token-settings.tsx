import { useEffect, useState } from 'react'
import {
  ApiTokenCreatedResponseSchema,
  ApiTokenListResponseSchema,
  MailboxListResponseSchema,
  type ApiTokenSummary,
  type ApiTokenScope,
  type MailboxSummary,
} from '@cloudflare-inbox/contracts'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '#/components/ui/field'

const PERMISSIONS: { value: ApiTokenScope; label: string; description: string }[] = [
  { value: 'read', label: 'Read', description: 'Read conversations and download attachments.' },
  { value: 'send', label: 'Send', description: 'Send mail, reply, and upload attachments.' },
  {
    value: 'settings',
    label: 'Settings and organization',
    description: 'Mark read, archive, move mail, and change inbox settings, including forwarding.',
  },
]

export function ApiTokenSettings() {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([])
  const [mailboxes, setMailboxes] = useState<MailboxSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<ApiTokenScope[]>(['read'])
  const [all, setAll] = useState(false)
  const [mailboxIds, setMailboxIds] = useState<string[]>([])
  const [expiry, setExpiry] = useState('30')
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const [tokenResponse, mailboxResponse] = await Promise.all([
          fetch('/api/v1/auth/api-tokens', { signal: controller.signal }),
          fetch('/api/v1/mailboxes', { signal: controller.signal }),
        ])
        if (!tokenResponse.ok || !mailboxResponse.ok) throw new Error('Load failed')
        setTokens(ApiTokenListResponseSchema.parse(await tokenResponse.json()).tokens)
        setMailboxes(MailboxListResponseSchema.parse(await mailboxResponse.json()).mailboxes)
      } catch {
        if (!controller.signal.aborted)
          setError('Could not load API tokens. Reopen this tab to retry.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [])

  async function create(event: React.FormEvent) {
    event.preventDefault()
    if (busy || loading || createdToken) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/v1/auth/api-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          scopes,
          mailboxIds: all ? null : mailboxIds,
          expiresAt:
            expiry === 'never'
              ? null
              : new Date(Date.now() + Number(expiry) * 86_400_000).toISOString(),
        }),
      })
      if (!response.ok) throw new Error('Create failed')
      const result = ApiTokenCreatedResponseSchema.parse(await response.json())
      setCreatedToken(result.token)
      setCopied(false)
      setTokens((current) => [result.apiToken, ...current])
      setName('')
    } catch {
      setError(
        'Could not create the token. Check your selections. If the connection was interrupted, reopen this tab to review and revoke any token you did not receive.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function revoke(id: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/v1/auth/api-tokens/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Revoke failed')
      setTokens((current) =>
        current.map((token) =>
          token.id === id ? { ...token, revokedAt: new Date().toISOString() } : token,
        ),
      )
    } catch {
      setError('Could not revoke the token. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-4 pt-4" aria-label="API tokens">
      <p className="text-sm text-muted-foreground">
        Give each agent its own token. Choose the permissions and inboxes it can access.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {createdToken ? (
        <div className="flex flex-col gap-3 rounded-lg border p-3" role="status">
          <p className="text-sm font-medium">
            Token created. Copy it now; it will not be shown again.
          </p>
          <Input
            aria-label="New API token"
            readOnly
            value={createdToken}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(createdToken)
                  setCopied(true)
                } catch {
                  setError('Clipboard unavailable. Select and copy the token above.')
                }
              }}
            >
              {copied ? 'Copied' : 'Copy token'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreatedToken(null)}>
              I saved the token
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void create(event)}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="api-token-name">Token name</FieldLabel>
              <Input
                id="api-token-name"
                value={name}
                maxLength={100}
                required
                placeholder="Support agent"
                disabled={busy || loading}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>
            <FieldSet className="gap-2" disabled={busy || loading}>
              <FieldLegend variant="label">Permissions</FieldLegend>
              {PERMISSIONS.map((permission) => (
                <label key={permission.value} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={scopes.includes(permission.value)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked
                      setScopes((current) =>
                        checked
                          ? [...current, permission.value]
                          : current.filter((scope) => scope !== permission.value),
                      )
                    }}
                  />
                  <span>
                    {permission.label}
                    <span className="block text-xs text-muted-foreground">
                      {permission.description}
                    </span>
                  </span>
                </label>
              ))}
            </FieldSet>
            <FieldSet className="gap-2" disabled={busy || loading}>
              <FieldLegend variant="label">Inbox access</FieldLegend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(event) => setAll(event.currentTarget.checked)}
                />
                All current and future inboxes
              </label>
              {!all ? (
                <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-lg border p-3">
                  {mailboxes.map((mailbox) => (
                    <label key={mailbox.id} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={mailboxIds.includes(mailbox.id)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked
                          setMailboxIds((current) =>
                            checked
                              ? [...current, mailbox.id]
                              : current.filter((id) => id !== mailbox.id),
                          )
                        }}
                      />
                      <span className="min-w-0 break-all">{mailbox.address}</span>
                    </label>
                  ))}
                  {!loading && !mailboxes.length ? (
                    <p className="text-xs text-muted-foreground">No inboxes available.</p>
                  ) : null}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Selected-inbox tokens cannot manage the shared spam blacklist or create inboxes.
                All-inbox tokens with Settings can do both.
              </p>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="api-token-expiry">Expires</FieldLabel>
              <select
                id="api-token-expiry"
                className="h-9 rounded-lg border bg-background px-2 text-sm"
                value={expiry}
                disabled={busy || loading}
                onChange={(event) => setExpiry(event.currentTarget.value)}
              >
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="never">Never</option>
              </select>
            </Field>
            <Button
              type="submit"
              disabled={
                busy || loading || !name.trim() || !scopes.length || (!all && !mailboxIds.length)
              }
            >
              {busy ? 'Creating…' : 'Create token'}
            </Button>
          </FieldGroup>
        </form>
      )}
      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-semibold">Your tokens</h3>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading tokens…</p>
        ) : !tokens.length ? (
          <p className="text-sm text-muted-foreground">No API tokens yet.</p>
        ) : null}
        <ul className="flex flex-col gap-3">
          {tokens.map((token) => {
            const expired = token.expiresAt !== null && Date.parse(token.expiresAt) <= Date.now()
            return (
              <li key={token.id} className="flex items-start gap-2 rounded-lg border p-3 text-xs">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="break-words text-sm font-medium">
                    {token.name}
                    {token.revokedAt ? ' · Revoked' : expired ? ' · Expired' : ''}
                  </p>
                  <p>{token.scopes.join(', ')}</p>
                  <p className="break-words text-muted-foreground">
                    {token.mailboxIds === null
                      ? 'All current and future inboxes'
                      : token.mailboxIds.length
                        ? token.mailboxIds
                            .map(
                              (id) =>
                                mailboxes.find((mailbox) => mailbox.id === id)?.address ??
                                'Unavailable inbox',
                            )
                            .join(', ')
                        : 'No remaining inbox access'}
                  </p>
                  <p className="text-muted-foreground">
                    {token.expiresAt
                      ? `Expires ${new Date(token.expiresAt).toLocaleDateString()}`
                      : 'Never expires'}{' '}
                    ·{' '}
                    {token.lastUsedAt
                      ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : 'Never used'}
                  </p>
                </div>
                {!token.revokedAt ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => void revoke(token.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
