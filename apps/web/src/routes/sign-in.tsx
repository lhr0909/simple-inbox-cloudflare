import { createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import type { FormEvent } from 'react'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'

import { Button, buttonVariants } from '#/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { requestMagicLink } from '#/features/inbox/inbox-api'
import { getServerAuthState } from '#/features/inbox/inbox-server'
import { getSetupState } from '#/features/setup/setup-server'

export const Route = createFileRoute('/sign-in')({
  loader: async () => {
    if ((await getSetupState()) === 'required') {
      throw redirect({ to: '/setup', replace: true })
    }
    if (await getServerAuthState()) {
      throw redirect({ to: '/inbox', search: { folder: 'all' }, replace: true })
    }
  },
  component: SignIn,
  head: () => ({ meta: [{ title: 'Sign in · Simple Inbox' }] }),
})

function SignIn() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'accepted' | 'error'>('idle')

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setStatus('sending')
    try {
      await requestMagicLink(email)
      setStatus('accepted')
    } catch {
      setStatus('error')
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/30 px-5 py-10">
      <section className="w-full max-w-sm rounded-2xl border bg-background p-6 shadow-sm sm:p-8">
        <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <MailOpenIcon aria-hidden="true" className="size-5" />
        </div>
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Sign in to your inbox</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Enter the approved owner email. We’ll send a one-time, short-lived sign-in link.
        </p>

        {status === 'accepted' ? (
          <div className="mt-6 rounded-xl border bg-muted/50 p-4" role="status">
            <p className="text-sm font-medium">Check your email</p>
            <p className="mt-1 text-sm text-muted-foreground">
              If the address is eligible, a sign-in link is on its way. It can be used once.
            </p>
          </div>
        ) : (
          <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
            <Field data-invalid={status === 'error' || undefined}>
              <FieldLabel htmlFor="email">Email address</FieldLabel>
              <Input
                aria-invalid={status === 'error' || undefined}
                autoComplete="email"
                id="email"
                onChange={(event) => setEmail(event.currentTarget.value)}
                placeholder="owner@example.test"
                required
                type="email"
                value={email}
              />
              <FieldDescription>
                {status === 'error'
                  ? 'The request could not be completed. Please wait a moment and try again.'
                  : 'Responses are intentionally identical for eligible and unknown addresses.'}
              </FieldDescription>
            </Field>
            <Button className="w-full" disabled={status === 'sending'} type="submit">
              {status === 'sending' ? 'Sending link…' : 'Email me a sign-in link'}
            </Button>
          </form>
        )}

        <div className="mt-6 flex items-center justify-between text-sm">
          <a className={buttonVariants({ size: 'sm', variant: 'ghost' })} href="/docs">
            Documentation
          </a>
          <span className="text-xs text-muted-foreground">No password required</span>
        </div>
      </section>
    </main>
  )
}
