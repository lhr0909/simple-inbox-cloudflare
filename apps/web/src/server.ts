import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

import {
  returnPathCookie,
  unauthorizedNavigationReturnPath,
} from '#/features/inbox/inbox-return-path'
import {
  fetchInternalApi,
  handleInboundEmail,
  handleScheduledRetention,
  rootBindings,
} from '#/internal-services.server'
import type { RootBindings } from '#/internal-services.server'

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
].join('; ')

const SAFE_API_REQUEST_HEADERS = [
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

function isPrivateDocument(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/sign-in' ||
    pathname === '/auth/verify' ||
    pathname === '/inbox' ||
    pathname === '/setup'
  )
}

const startEntry = createServerEntry({
  async fetch(request, options) {
    const startedAt = Date.now()
    const requestId = crypto.randomUUID()
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-request-id', requestId)
    const identifiedRequest = new Request(request, { headers: requestHeaders })

    let response: Response
    try {
      response = isPublicApiPath(new URL(request.url).pathname)
        ? await proxyApiRequest(identifiedRequest)
        : await handler.fetch(identifiedRequest, options)
    } catch (error) {
      logRequest(request, requestId, 500, startedAt)
      throw error
    }

    const securedResponse = secureResponse(request, response, requestId)
    const responseRequestId = securedResponse.headers.get('x-request-id') ?? requestId
    logRequest(request, responseRequestId, securedResponse.status, startedAt)
    return securedResponse
  },
})

export default {
  async email(message, bindings, context) {
    await handleInboundEmail(message, bindings, context)
  },
  async fetch(request) {
    return startEntry.fetch(request)
  },
  async scheduled(controller, bindings, context) {
    await handleScheduledRetention(controller, bindings, context)
  },
} satisfies ExportedHandler<RootBindings>

function isPublicApiPath(pathname: string): boolean {
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/')
}

async function proxyApiRequest(request: Request): Promise<Response> {
  const incoming = new URL(request.url)
  const suffix = incoming.pathname.slice('/api/v1'.length)
  const upstream = new URL('https://api.internal')
  upstream.pathname = suffix === '/health' ? '/health' : `/v1${suffix || '/'}`
  upstream.search = incoming.search

  // Using the incoming request as RequestInit preserves Cloudflare's immutable
  // request metadata while the second construction replaces browser-controlled
  // headers with the narrow allowlist below.
  const retargeted = new Request(upstream, request as unknown as RequestInit)
  const proxied = new Request(retargeted, {
    headers: forwardedApiHeaders(request, incoming),
    redirect: 'manual',
  })
  const response = await fetchInternalApi(proxied)
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

function forwardedApiHeaders(request: Request, incoming: URL): Headers {
  const headers = new Headers()
  for (const name of SAFE_API_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  headers.set('x-forwarded-host', incoming.host)
  headers.set('x-forwarded-proto', incoming.protocol.slice(0, -1))
  headers.set('x-request-id', crypto.randomUUID())

  if ((request as Request & { readonly cf?: unknown }).cf !== undefined) {
    const sourceAddress = request.headers.get('cf-connecting-ip')
    if (sourceAddress !== null) headers.set('cf-connecting-ip', sourceAddress)
  }
  return headers
}

function secureResponse(request: Request, response: Response, fallbackRequestId: string): Response {
  const headers = new Headers(response.headers)
  headers.set('content-security-policy', CONTENT_SECURITY_POLICY)
  headers.set('cross-origin-opener-policy', 'same-origin')
  headers.set('cross-origin-resource-policy', 'same-origin')
  headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=()')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('x-frame-options', 'DENY')
  headers.set('x-request-id', response.headers.get('x-request-id') ?? fallbackRequestId)

  const url = new URL(request.url)
  if (url.protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
  }
  if (isPrivateDocument(url.pathname)) headers.set('cache-control', 'private, no-store')

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

function logRequest(request: Request, requestId: string, status: number, startedAt: number): void {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'app',
    environment: rootBindings().ENVIRONMENT,
    requestId,
    event: 'app.request.completed',
    method: request.method,
    path: new URL(request.url).pathname,
    durationMs: Math.max(0, Date.now() - startedAt),
    outcome: status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success',
    status,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}
