import { useState } from 'react'
import type { FormEvent } from 'react'
import ArrowLeftIcon from 'lucide-react/dist/esm/icons/arrow-left.mjs'
import ArrowRightIcon from 'lucide-react/dist/esm/icons/arrow-right.mjs'
import CheckIcon from 'lucide-react/dist/esm/icons/check.mjs'
import CheckCircleIcon from 'lucide-react/dist/esm/icons/circle-check-big.mjs'
import DatabaseIcon from 'lucide-react/dist/esm/icons/database.mjs'
import MailIcon from 'lucide-react/dist/esm/icons/mail.mjs'
import MailOpenIcon from 'lucide-react/dist/esm/icons/mail-open.mjs'
import ShieldCheckIcon from 'lucide-react/dist/esm/icons/shield-check.mjs'

import {
  CompleteSetupRequestSchema,
  EmailAddressSchema,
  MailDomainSchema,
} from '@cloudflare-inbox/contracts'
import type { CompleteSetupRequest } from '@cloudflare-inbox/contracts'

import { Button, buttonVariants } from '#/components/ui/button'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import { cn } from '#/lib/utils'

import { completeSetup } from './setup-api'

const STEPS = [
  { description: 'Authorize this first run', icon: ShieldCheckIcon, label: 'Installation' },
  { description: 'Choose the owner and address', icon: MailIcon, label: 'Mailbox' },
  { description: 'Keep your data', icon: DatabaseIcon, label: 'Retention' },
  { description: 'Confirm and activate', icon: CheckCircleIcon, label: 'Finish' },
] as const

type FieldErrors = Partial<Record<keyof CompleteSetupRequest | 'form', string>>

export function SetupWizard() {
  const [step, setStep] = useState(0)
  const [setupToken, setSetupToken] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [mailDomain, setMailDomain] = useState('')
  const [mailboxAddress, setMailboxAddress] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [complete, setComplete] = useState(false)

  const normalizedOwner = ownerEmail.trim().toLowerCase()
  const normalizedDomain = mailDomain.trim().toLowerCase()
  const normalizedMailbox = mailboxAddress.trim().toLowerCase()

  function advance(): void {
    const nextErrors = validateStep(step)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length === 0) setStep((current) => Math.min(3, current + 1))
  }

  function retreat(): void {
    setErrors({})
    setStep((current) => Math.max(0, current - 1))
  }

  function validateStep(targetStep: number): FieldErrors {
    if (targetStep === 0) {
      return new TextEncoder().encode(setupToken).byteLength < 32
        ? {
            setupToken: 'Enter the setup token from your deployment. It must be at least 32 bytes.',
          }
        : {}
    }
    if (targetStep === 1) {
      const next: FieldErrors = {}
      if (!EmailAddressSchema.safeParse(normalizedOwner).success) {
        next.ownerEmail = 'Enter a valid owner email address.'
      }
      if (!MailDomainSchema.safeParse(normalizedDomain).success) {
        next.mailDomain = 'Enter a valid lower-case mail domain.'
      }
      if (!EmailAddressSchema.safeParse(normalizedMailbox).success) {
        next.mailboxAddress = 'Enter a valid inbox email address.'
      } else if (normalizedDomain && !normalizedMailbox.endsWith(`@${normalizedDomain}`)) {
        next.mailboxAddress = 'The inbox address must use the mail domain above.'
      }
      return next
    }
    return {}
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (step < 3) {
      advance()
      return
    }

    const input = CompleteSetupRequestSchema.safeParse({
      mailDomain: normalizedDomain,
      mailboxAddress: normalizedMailbox,
      ownerEmail: normalizedOwner,
      setupToken,
    })
    if (!input.success) {
      setErrors({ ...issuesToErrors(input.error.issues), form: 'Review the highlighted settings.' })
      return
    }

    setSubmitting(true)
    setErrors({})
    try {
      const result = await completeSetup(input.data)
      if (result.status !== 'complete') throw new Error('Setup did not complete.')
      setComplete(true)
    } catch {
      setErrors({
        form: 'Setup could not be completed. Check the setup token and try again.',
        setupToken: 'Re-enter the setup token before trying again.',
      })
      setStep(0)
    } finally {
      setSetupToken('')
      setSubmitting(false)
    }
  }

  if (complete) {
    return <SetupComplete mailboxAddress={normalizedMailbox} />
  }

  return (
    <div className="min-h-dvh bg-muted/25 text-foreground">
      <header className="border-b bg-background/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <MailOpenIcon aria-hidden="true" className="size-4.5" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-tight">Simple Inbox</p>
              <p className="text-xs text-muted-foreground">First-run setup</p>
            </div>
          </div>
          <span className="rounded-full border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground">
            Self-hosted
          </span>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        <MobileProgress step={step} />
        <div className="grid items-start gap-8 md:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
          <StepRail step={step} />
          <section className="overflow-hidden rounded-2xl border bg-background shadow-sm">
            <form action="/setup" method="post" onSubmit={(event) => void submit(event)}>
              <div className="border-b px-6 py-6 sm:px-8 sm:py-7">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Step {step + 1} of {STEPS.length}
                </p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight">{stepTitle(step)}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {stepDescription(step)}
                </p>
              </div>

              <div className="min-h-[25rem] px-6 py-7 sm:px-8">
                {step === 0 ? (
                  <InstallationStep
                    {...(errors.setupToken === undefined ? {} : { error: errors.setupToken })}
                    setupToken={setupToken}
                    setSetupToken={setSetupToken}
                  />
                ) : null}
                {step === 1 ? (
                  <MailboxStep
                    errors={errors}
                    mailDomain={mailDomain}
                    mailboxAddress={mailboxAddress}
                    ownerEmail={ownerEmail}
                    setMailDomain={(value) => {
                      const domain = value.trim().toLowerCase()
                      setMailDomain(domain)
                      if (!mailboxAddress || mailboxAddress.startsWith('inbox@')) {
                        setMailboxAddress(domain ? `inbox@${domain}` : '')
                      }
                    }}
                    setMailboxAddress={setMailboxAddress}
                    setOwnerEmail={setOwnerEmail}
                  />
                ) : null}
                {step === 2 ? <RetentionStep /> : null}
                {step === 3 ? (
                  <ReviewStep
                    mailDomain={normalizedDomain}
                    mailboxAddress={normalizedMailbox}
                    ownerEmail={normalizedOwner}
                  />
                ) : null}
                {errors.form ? <FieldError className="mt-5">{errors.form}</FieldError> : null}
              </div>

              <div className="flex items-center justify-between border-t bg-muted/20 px-6 py-4 sm:px-8">
                {step === 0 ? (
                  <a className={buttonVariants({ variant: 'ghost' })} href="/docs">
                    Read the docs
                  </a>
                ) : (
                  <Button onClick={retreat} type="button" variant="ghost">
                    <ArrowLeftIcon aria-hidden="true" /> Back
                  </Button>
                )}
                {step < 3 ? (
                  <Button
                    key="continue"
                    onClick={(event) => {
                      event.preventDefault()
                      advance()
                    }}
                    type="button"
                  >
                    Continue <ArrowRightIcon aria-hidden="true" />
                  </Button>
                ) : (
                  <Button disabled={submitting} key="finish" type="submit">
                    {submitting ? 'Finishing setup…' : 'Finish setup'}
                  </Button>
                )}
              </div>
            </form>
          </section>
        </div>
      </main>
    </div>
  )
}

function InstallationStep({
  error,
  setupToken,
  setSetupToken,
}: {
  error?: string
  setupToken: string
  setSetupToken: (value: string) => void
}) {
  return (
    <div className="max-w-xl">
      <div className="mb-6 flex gap-3 rounded-xl border bg-muted/30 p-4">
        <DatabaseIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">Storage is connected</p>
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            The deployment created this Worker’s D1 database and private R2 bucket. This wizard only
            writes your installation settings to D1.
          </p>
        </div>
      </div>
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="setup-token">Setup token</FieldLabel>
        <Input
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          autoFocus
          id="setup-token"
          onChange={(event) => setSetupToken(event.currentTarget.value)}
          placeholder="Paste the secret entered during deployment"
          required
          type="password"
          value={setupToken}
        />
        <FieldDescription>
          It is sent once for verification and is never saved in D1, returned, or logged.
        </FieldDescription>
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
    </div>
  )
}

function MailboxStep({
  errors,
  mailDomain,
  mailboxAddress,
  ownerEmail,
  setMailDomain,
  setMailboxAddress,
  setOwnerEmail,
}: {
  errors: FieldErrors
  mailDomain: string
  mailboxAddress: string
  ownerEmail: string
  setMailDomain: (value: string) => void
  setMailboxAddress: (value: string) => void
  setOwnerEmail: (value: string) => void
}) {
  return (
    <FieldGroup className="max-w-xl">
      <Field data-invalid={errors.ownerEmail ? true : undefined}>
        <FieldLabel htmlFor="owner-email">Owner email</FieldLabel>
        <Input
          aria-invalid={errors.ownerEmail ? true : undefined}
          autoComplete="email"
          id="owner-email"
          onChange={(event) => setOwnerEmail(event.currentTarget.value)}
          placeholder="you@example.test"
          required
          type="email"
          value={ownerEmail}
        />
        <FieldDescription>Magic sign-in links and forwarded mail are sent here.</FieldDescription>
        {errors.ownerEmail ? <FieldError>{errors.ownerEmail}</FieldError> : null}
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field data-invalid={errors.mailDomain ? true : undefined}>
          <FieldLabel htmlFor="mail-domain">Mail domain</FieldLabel>
          <Input
            aria-invalid={errors.mailDomain ? true : undefined}
            autoCapitalize="none"
            id="mail-domain"
            onChange={(event) => setMailDomain(event.currentTarget.value)}
            placeholder="mail.example.test"
            required
            spellCheck={false}
            value={mailDomain}
          />
          <FieldDescription>The domain configured in Email Routing.</FieldDescription>
          {errors.mailDomain ? <FieldError>{errors.mailDomain}</FieldError> : null}
        </Field>
        <Field data-invalid={errors.mailboxAddress ? true : undefined}>
          <FieldLabel htmlFor="mailbox-address">Inbox address</FieldLabel>
          <Input
            aria-invalid={errors.mailboxAddress ? true : undefined}
            autoCapitalize="none"
            id="mailbox-address"
            onChange={(event) => setMailboxAddress(event.currentTarget.value)}
            placeholder="inbox@mail.example.test"
            required
            spellCheck={false}
            type="email"
            value={mailboxAddress}
          />
          <FieldDescription>Your first routed address.</FieldDescription>
          {errors.mailboxAddress ? <FieldError>{errors.mailboxAddress}</FieldError> : null}
        </Field>
      </div>
    </FieldGroup>
  )
}

function RetentionStep() {
  return (
    <div className="max-w-2xl space-y-4 text-sm leading-6">
      <p>Mail and attachments are kept indefinitely. There is no automatic expiration.</p>
      <p className="text-muted-foreground">
        Moving mail to Spam or Trash does not permanently delete it. You control when stored data is
        removed.
      </p>
      <p className="text-muted-foreground">
        Keep R2 object expiration rules disabled so Cloudflare does not delete retained files.
      </p>
    </div>
  )
}

function ReviewStep({
  mailDomain,
  mailboxAddress,
  ownerEmail,
}: {
  mailDomain: string
  mailboxAddress: string
  ownerEmail: string
}) {
  const rows = [
    ['Owner', ownerEmail],
    ['Inbox', mailboxAddress],
    ['Mail domain', mailDomain],
    ['Retention', 'Keep indefinitely — no automatic expiration'],
  ]
  return (
    <div className="max-w-2xl">
      <dl className="divide-y rounded-xl border">
        {rows.map(([label, value]) => (
          <div className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_1fr]" key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="break-words text-sm font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-6 rounded-xl bg-muted/45 p-5">
        <p className="text-sm font-medium">After this step</p>
        <ul className="mt-3 space-y-2 text-sm leading-5 text-muted-foreground">
          <li className="flex gap-2">
            <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground" />
            Verify your sending domain in Cloudflare Email Sending.
          </li>
          <li className="flex gap-2">
            <CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-foreground" />
            Point an Email Routing address or catch-all at this Worker.
          </li>
        </ul>
      </div>
    </div>
  )
}

function StepRail({ step }: { step: number }) {
  return (
    <nav aria-label="Setup progress" className="hidden md:block">
      <ol className="space-y-1">
        {STEPS.map((item, index) => {
          const Icon = item.icon
          const finished = index < step
          const active = index === step
          return (
            <li key={item.label}>
              <div
                aria-current={active ? 'step' : undefined}
                className={cn(
                  'flex items-start gap-3 rounded-xl px-3 py-3',
                  active ? 'bg-background shadow-sm ring-1 ring-border' : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border text-xs',
                    active && 'border-primary bg-primary text-primary-foreground',
                    finished && 'border-foreground bg-foreground text-background',
                  )}
                >
                  {finished ? (
                    <CheckIcon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Icon aria-hidden="true" className="size-3.5" />
                  )}
                </span>
                <span>
                  <span className={cn('block text-sm font-medium', active && 'text-foreground')}>
                    {item.label}
                  </span>
                  <span className="mt-0.5 block text-xs leading-4">{item.description}</span>
                </span>
              </div>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function MobileProgress({ step }: { step: number }) {
  return (
    <div className="mb-5 md:hidden">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>{STEPS[step]?.label}</span>
        <span>
          {step + 1} / {STEPS.length}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden="true">
        {STEPS.map((item, index) => (
          <span
            className={cn('h-1 rounded-full bg-border', index <= step && 'bg-foreground')}
            key={item.label}
          />
        ))}
      </div>
    </div>
  )
}

function SetupComplete({ mailboxAddress }: { mailboxAddress: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/25 px-5 py-10">
      <section className="w-full max-w-lg rounded-2xl border bg-background p-7 text-center shadow-sm sm:p-9">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <CheckIcon aria-hidden="true" className="size-6" />
        </div>
        <p className="mt-6 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Installation complete
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Your inbox is configured</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Sign in as the owner after Cloudflare Email Sending and Email Routing are connected. Your
          first inbox is <span className="font-medium text-foreground">{mailboxAddress}</span>.
        </p>
        <div className="mt-7 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <a className={buttonVariants({ size: 'lg' })} href="/sign-in">
            Continue to sign in
          </a>
          <a className={buttonVariants({ size: 'lg', variant: 'outline' })} href="/docs/deployment">
            Activation guide
          </a>
        </div>
      </section>
    </main>
  )
}

function issuesToErrors(
  issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>,
): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path[0]
    if (typeof key === 'string' && !(key in errors)) {
      errors[key as keyof CompleteSetupRequest] = issue.message
    }
  }
  return errors
}

function stepTitle(step: number): string {
  return (
    [
      'Secure this installation',
      'Create your first mailbox',
      'Your data stays yours',
      'Review your setup',
    ][step] ?? 'Set up Simple Inbox'
  )
}

function stepDescription(step: number): string {
  return (
    [
      'Confirm that you are the person who deployed this Worker before any account data is created.',
      'These details become the single source of truth for sign-in, forwarding, and inbound routing.',
      'Mail and attachments stay available until you choose to remove them.',
      'Finishing is atomic and can only happen once. Cloudflare email activation remains an explicit owner step.',
    ][step] ?? ''
  )
}
