import { createFileRoute, redirect } from '@tanstack/react-router'

import { OpaqueAuthTokenSchema } from '@cloudflare-inbox/contracts/ids'

import { verifyMagicLinkServer } from '#/features/inbox/inbox-server'

type VerifySearch = Readonly<{
  error?: 'expired' | 'unavailable'
  token?: string
}>

export function parseVerifySearch(input: unknown): VerifySearch {
  const search = typeof input === 'object' && input !== null ? input : {}
  const record = search as Readonly<Record<string, unknown>>
  const token = OpaqueAuthTokenSchema.safeParse(record['token'])
  const error =
    record['error'] === 'expired' || record['error'] === 'unavailable' ? record['error'] : undefined

  return {
    ...(error === undefined ? {} : { error }),
    ...(token.success ? { token: token.data } : {}),
  }
}

export function verificationFailureHref(
  status: 'invalid' | 'retryable',
): '/auth/verify?error=expired' | '/auth/verify?error=unavailable' {
  return status === 'retryable' ? '/auth/verify?error=unavailable' : '/auth/verify?error=expired'
}

export const Route = createFileRoute('/auth/verify')({
  validateSearch: parseVerifySearch,
  loaderDeps: ({ search }) => parseVerifySearch(search),
  loader: async ({ deps }) => {
    if (deps.error === 'expired') return { status: 'invalid' as const }
    if (deps.error === 'unavailable') return { status: 'retryable' as const }
    if (deps.token === undefined) {
      throw redirect({
        href: verificationFailureHref('invalid'),
        replace: true,
      })
    }

    const result = await verifyMagicLinkServer({ data: { token: deps.token } })
    if (result.status === 'retryable') {
      throw redirect({
        href: verificationFailureHref(result.status),
        replace: true,
      })
    }
    if (result.status === 'verified') throw redirect({ href: result.returnTo, replace: true })
    throw redirect({
      href: verificationFailureHref(result.status),
      replace: true,
    })
  },
  component: VerifyMagicLinkPage,
  head: () => ({
    meta: [
      { title: 'Sign-in link · Cloudflare Inbox' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
})

function VerifyMagicLinkPage() {
  const result = Route.useLoaderData()
  if (result.status === 'retryable') return <RetryableMagicLink />

  return (
    <main className="grid min-h-dvh place-items-center bg-muted/30 px-6 text-center">
      <div>
        <h1 className="text-base font-semibold">This sign-in link is invalid or expired</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Request a new one. For your security, every link is short-lived and can be used once.
        </p>
        <a
          className="mt-4 inline-block text-sm font-medium underline underline-offset-4"
          href="/sign-in"
        >
          Return to sign in
        </a>
      </div>
    </main>
  )
}

function RetryableMagicLink() {
  return (
    <main className="grid min-h-dvh place-items-center bg-muted/30 px-6 text-center">
      <div>
        <h1 className="text-base font-semibold">Sign-in is temporarily unavailable</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Your original link was not consumed. Reopen it from your email when the service is
          available, or request a new one.
        </p>
        <a
          className="mt-4 inline-block text-sm font-medium underline underline-offset-4"
          href="/sign-in"
        >
          Request a new link
        </a>
      </div>
    </main>
  )
}
