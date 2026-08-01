import { describe, expect, it } from 'vitest'

import { parseVerifySearch, verificationFailureHref } from './auth.verify'

const SYNTHETIC_TOKEN = 'K3wnMJz4uVVYHF4eBgfRrtDXRskMJLR3zk4JP8Z_LjY'

describe('magic-link verification URL state', () => {
  it('accepts the token-free unavailable state', () => {
    expect(parseVerifySearch({ error: 'unavailable' })).toEqual({ error: 'unavailable' })
  })

  it('keeps invalid and expired search behavior', () => {
    expect(parseVerifySearch({ error: 'expired' })).toEqual({ error: 'expired' })
    expect(parseVerifySearch({ error: 'unknown', token: 'short-secret' })).toEqual({})
    expect(parseVerifySearch({ token: SYNTHETIC_TOKEN })).toEqual({ token: SYNTHETIC_TOKEN })
  })

  it('redirects retryable failures to a token-free URL', () => {
    const href = verificationFailureHref('retryable')

    expect(href).toBe('/auth/verify?error=unavailable')
    expect(href).not.toContain(SYNTHETIC_TOKEN)
    expect(verificationFailureHref('invalid')).toBe('/auth/verify?error=expired')
  })
})
