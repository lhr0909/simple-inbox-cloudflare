import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import type {} from '@tanstack/react-start'

import {
  returnPathCookie,
  unauthorizedNavigationReturnPath,
} from '#/features/inbox/inbox-return-path'

type ProxyContext = Readonly<{
  request: Request
  params: { _splat?: string }
}>

const SAFE_REQUEST_HEADERS = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'range',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
] as const

function forwardedHeaders(request: Request, incoming: URL): Headers {
  const headers = new Headers()
  for (const name of SAFE_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('x-forwarded-host', incoming.host)
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1))
  headers.set('x-request-id', crypto.randomUUID())

  // Cloudflare supplies this header at the edge. Forward it only when the
  // runtime-only request metadata is present, so a local/browser-supplied
  // header cannot manufacture a fresh API rate-limit bucket.
  if ((request as Request & { readonly cf?: unknown }).cf !== undefined) {
    const sourceAddress = request.headers.get('cf-connecting-ip')
    if (sourceAddress !== null) headers.set('cf-connecting-ip', sourceAddress)
  }
  return headers
}

async function proxyApiRequest({ request, params }: ProxyContext): Promise<Response> {
  const incoming = new URL(request.url)
  const upstream = new URL('https://api.internal')
  upstream.pathname = params._splat === 'health' ? '/health' : `/v1/${params._splat ?? ''}`
  upstream.search = incoming.search

  // Passing the incoming Request as RequestInit is the Cloudflare-supported
  // way to retain its immutable `cf` metadata while retargeting the URL. The
  // second construction replaces all externally controlled headers with the
  // narrow allowlist above while retaining method, body, signal, and metadata.
  const retargeted = new Request(upstream, request as unknown as RequestInit)
  const proxied = new Request(retargeted, {
    headers: forwardedHeaders(request, incoming),
    redirect: 'manual',
  })
  const response = await env.API.fetch(proxied)
  if (response.status !== 401) return response

  const returnTo = unauthorizedNavigationReturnPath(request)
  if (returnTo === null) return response
  return new Response(null, {
    headers: {
      'cache-control': 'private, no-store',
      location: '/sign-in',
      'referrer-policy': 'no-referrer',
      'set-cookie': returnPathCookie(returnTo, 15 * 60, incoming.protocol === 'https:'),
      vary: 'Cookie',
    },
    status: 303,
  })
}

export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: proxyApiRequest,
      POST: proxyApiRequest,
      PATCH: proxyApiRequest,
      DELETE: proxyApiRequest,
      OPTIONS: proxyApiRequest,
    },
  },
})
