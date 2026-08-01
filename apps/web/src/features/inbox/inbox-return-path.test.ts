import { describe, expect, it } from 'vitest'

import {
  readReturnPathCookie,
  returnPathCookie,
  safeReturnPath,
  unauthorizedNavigationReturnPath,
} from './inbox-return-path'

const MESSAGE_ID = '019b08e0-3000-7000-8000-000000000001'
const ATTACHMENT_ID = '019b08e0-4000-7000-8000-000000000001'

describe('safe auth return paths', () => {
  it('keeps only validated inbox state and strips unknown sensitive parameters', () => {
    expect(
      safeReturnPath(`/inbox?folder=archive&unread=1&thread=${MESSAGE_ID}&token=must-not-survive`),
    ).toBe(`/inbox?folder=archive&unread=1&thread=${MESSAGE_ID}`)
  })

  it('allows only scoped raw-message and attachment downloads', () => {
    expect(safeReturnPath(`/api/v1/messages/${MESSAGE_ID}/raw`)).toBe(
      `/api/v1/messages/${MESSAGE_ID}/raw`,
    )
    expect(safeReturnPath(`/api/v1/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`)).toBe(
      `/api/v1/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
    )
  })

  it('rejects absolute, protocol-relative, and unrelated paths', () => {
    expect(safeReturnPath('https://evil.example/inbox')).toBeNull()
    expect(safeReturnPath('//evil.example/inbox')).toBeNull()
    expect(safeReturnPath('/docs')).toBeNull()
  })

  it('uses a short-lived hardened cookie and only recovers validated values', () => {
    const path = `/api/v1/messages/${MESSAGE_ID}/raw`
    const cookie = returnPathCookie(path, 900, true)

    expect(cookie).toContain('Max-Age=900; Path=/; HttpOnly; SameSite=Lax; Secure')
    expect(readReturnPathCookie(cookie)).toBe(path)
    expect(readReturnPathCookie('cloudflare_inbox_return=https%3A%2F%2Fevil.example')).toBeNull()
  })

  it('redirects only document navigations, not API fetches, after a 401', () => {
    const path = `/api/v1/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`
    expect(
      unauthorizedNavigationReturnPath(
        new Request(`https://inbox.example.test${path}`, {
          headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
        }),
      ),
    ).toBe(path)
    expect(
      unauthorizedNavigationReturnPath(new Request(`https://inbox.example.test${path}`)),
    ).toBeNull()
  })
})
