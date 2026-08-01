import { env, exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

import { fetchMailHealth } from '../../src/services/mail-client'

describe('API Worker runtime', () => {
  it('serves health from workerd with the baseline response protections', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers')

    const response = await exports.default.fetch(
      new Request('https://api.example.test/health', {
        headers: { 'x-request-id': 'runtime_smoke_20260801' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'api' })
    expect(response.headers.get('x-request-id')).toBe('runtime_smoke_20260801')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('cache-control')).toBeNull()
  })

  it('keeps unauthenticated session state private inside the Worker runtime', async () => {
    const response = await exports.default.fetch('https://api.example.test/v1/auth/session')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('provides MAIL as an in-process private service binding', async () => {
    const response = await fetchMailHealth(
      env.MAIL,
      'runtime_binding_20260801',
      new AbortController().signal,
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('x-test-service-binding')).toBe('MAIL')
  })
})
