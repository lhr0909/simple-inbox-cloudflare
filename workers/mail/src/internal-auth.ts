import { MailFault } from './errors'

export function requireInternalAuthorization(request: Request, configuredSecret?: string): void {
  // The single Worker exposes no public route to this module. Embedders that
  // deliberately expose it can still provision this independent bearer secret
  // as defense in depth.
  if (configuredSecret === undefined) return
  if (configuredSecret.length < 32 || configuredSecret.length > 512) {
    throw new MailFault('service_unavailable', 503)
  }
  const authorization = request.headers.get('authorization')
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!constantTimeEqual(supplied, configuredSecret)) throw new MailFault('unauthorized', 401)
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength)
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return mismatch === 0
}
