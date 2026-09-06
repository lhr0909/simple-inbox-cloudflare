const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export function resolveRequestId(request: Request): string {
  const incoming = request.headers.get('x-request-id')
  return incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID()
}
