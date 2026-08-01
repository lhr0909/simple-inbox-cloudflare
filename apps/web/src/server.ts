import { env } from 'cloudflare:workers'
import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

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

function isPrivateDocument(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/sign-in' ||
    pathname === '/auth/verify' ||
    pathname === '/inbox'
  )
}

export default createServerEntry({
  async fetch(request, options) {
    const startedAt = Date.now()
    const requestId = crypto.randomUUID()
    const requestHeaders = new Headers(request.headers)
    requestHeaders.set('x-request-id', requestId)

    let response: Response
    try {
      response = await handler.fetch(new Request(request, { headers: requestHeaders }), options)
    } catch (error) {
      logRequest(request, requestId, 500, startedAt)
      throw error
    }
    const headers = new Headers(response.headers)
    headers.set('content-security-policy', CONTENT_SECURITY_POLICY)
    headers.set('cross-origin-opener-policy', 'same-origin')
    headers.set('cross-origin-resource-policy', 'same-origin')
    headers.set('permissions-policy', 'camera=(), geolocation=(), microphone=()')
    headers.set('referrer-policy', 'no-referrer')
    headers.set('x-content-type-options', 'nosniff')
    headers.set('x-frame-options', 'DENY')
    const responseRequestId = response.headers.get('x-request-id') ?? requestId
    headers.set('x-request-id', responseRequestId)

    if (new URL(request.url).protocol === 'https:') {
      headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }

    if (isPrivateDocument(new URL(request.url).pathname)) {
      headers.set('cache-control', 'private, no-store')
    }

    const securedResponse = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    })
    logRequest(request, responseRequestId, securedResponse.status, startedAt)
    return securedResponse
  },
})

function logRequest(request: Request, requestId: string, status: number, startedAt: number): void {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: 'web',
    environment: env.ENVIRONMENT,
    requestId,
    event: 'web.request.completed',
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
