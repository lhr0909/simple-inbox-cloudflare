import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'

describe('mail Worker runtime', () => {
  it('serves private health from workerd with baseline response protections', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers')

    const response = await exports.default.fetch(
      new Request('https://mail.example.test/internal/health', {
        headers: { 'x-request-id': 'runtime_mail_smoke_20260801' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, service: 'mail' })
    expect(response.headers.get('x-request-id')).toBe('runtime_mail_smoke_20260801')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('rejects protected internal HTTP routes before persistence without the operator secret', async () => {
    const response = await exports.default.fetch(
      new Request('https://mail.example.test/internal/v1/sends/runtime-send-key-0001', {
        headers: { 'x-request-id': 'runtime_mail_auth_20260801' },
      }),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthorized', requestId: 'runtime_mail_auth_20260801' },
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('pragma')).toBe('no-cache')
  })
})
