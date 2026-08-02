import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { RootProvider } from 'fumadocs-ui/provider/tanstack'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Simple Inbox',
      },
      {
        name: 'description',
        content: 'A private, searchable inbox for Cloudflare Email Routing.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  errorComponent: RootErrorBoundary,
  notFoundComponent: RootNotFound,
  shellComponent: RootDocument,
})

function RootErrorBoundary() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          This page could not be loaded. No account or message details have been shown.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
          <a
            className="inline-flex h-9 items-center justify-center rounded-lg border bg-background px-4 text-sm font-medium"
            href="/"
          >
            Return to inbox
          </a>
          <a
            className="inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium hover:bg-muted"
            href="/docs"
          >
            Documentation
          </a>
        </div>
      </section>
    </main>
  )
}

function RootNotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-12 text-foreground">
      <section className="w-full max-w-md rounded-2xl border bg-card p-6 text-center shadow-sm">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="mt-1 text-xl font-semibold">Page not found</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The address may be outdated, or the page may have moved.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <a
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground"
            href="/"
          >
            Return to inbox
          </a>
          <a
            className="inline-flex h-9 items-center justify-center rounded-lg border bg-background px-4 text-sm font-medium"
            href="/docs"
          >
            Documentation
          </a>
        </div>
      </section>
    </main>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <RootProvider
          search={{ options: { api: '/api/search', type: 'static' } }}
          theme={{ enabled: true, storageKey: 'simple-inbox-theme' }}
        >
          {children}
        </RootProvider>

        <Scripts />
      </body>
    </html>
  )
}
