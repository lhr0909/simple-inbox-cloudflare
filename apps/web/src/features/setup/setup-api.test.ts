import { afterEach, describe, expect, it, vi } from 'vitest'

import { completeSetup } from './setup-api'

afterEach(() => vi.unstubAllGlobals())

describe('setup client', () => {
  it('sends the setup token only in the same-origin request body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('/api/v1/setup')
      expect(init?.credentials).toBe('same-origin')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        setupToken: 'setup-token-0000000000000000000000000000',
      })
      return Response.json({ status: 'complete' }, { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      completeSetup({
        applicationRecordRetentionDays: 90,
        mailDomain: 'mail.example.test',
        mailboxAddress: 'inbox@mail.example.test',
        ownerEmail: 'owner@example.test',
        rawEmailRetentionDays: 30,
        retentionBatchSize: 100,
        setupToken: 'setup-token-0000000000000000000000000000',
      }),
    ).resolves.toEqual({ status: 'complete' })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
