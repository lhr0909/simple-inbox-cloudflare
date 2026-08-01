import { sha256Hex } from '@cloudflare-inbox/mail-core'
import type { CompleteInstallationInput } from '@cloudflare-inbox/db'
import { describe, expect, it, vi } from 'vitest'

import { SESSION_COOKIE_MAX_AGE_SECONDS } from '../src/auth'
import { createApiApp } from '../src/index'
import type {
  ApiBindings,
  ApiDependencies,
  AuthRepositoryPort,
  InboxRepositoryPort,
} from '../src/types'

const USER_ID = '01996f7a-7bcd-7abc-8def-0123456789ab'
const MAILBOX_ID = '01996f7a-7bcd-7abc-8def-1123456789ab'
const THREAD_ID = '01996f7a-7bcd-7abc-8def-2123456789ab'
const MESSAGE_ID = '01996f7a-7bcd-7abc-8def-3123456789ab'
const ATTACHMENT_ID = '01996f7a-7bcd-7abc-8def-4123456789ab'
const MAGIC_LINK_ID = '01996f7a-7bcd-7abc-8def-6123456789ab'
const SESSION_ID = '01996f7a-7bcd-7abc-8def-7123456789ab'
const SEND_ID = '01996f7a-7bcd-7abc-8def-9123456789ab'
const MAGIC_TOKEN = 'A'.repeat(43)
const SESSION_TOKEN = 'B'.repeat(43)
const API_TOKEN = 'C'.repeat(43)
const NOW = Date.parse('2026-08-01T05:00:00.000Z')
const EXPIRES_AT = NOW + 30 * 24 * 60 * 60 * 1_000
const RAW_SHA256 = 'd'.repeat(64)

describe('API Worker', () => {
  it('serves liveness and generated OpenAPI with stable request IDs', async () => {
    const fixture = createFixture()
    const health = await fixture.app.request(
      new Request('https://api.example.test/health', {
        headers: { 'x-request-id': 'trace_phase0_1234' },
      }),
      undefined,
      fixture.env,
    )
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, service: 'api' })
    expect(health.headers.get('x-request-id')).toBe('trace_phase0_1234')

    const document = await fixture.app.request('/v1/openapi.json', undefined, fixture.env)
    expect(document.status).toBe(200)
    const json = (await document.json()) as { paths: Record<string, unknown> }
    expect(json.paths).toHaveProperty('/v1/auth/magic-links')
    expect(json.paths).toHaveProperty('/v1/setup')
    expect(json.paths).toHaveProperty('/v1/messages/{messageId}/raw')
    expect(json.paths).not.toHaveProperty('/internal/v1/send')

    const replaced = await fixture.app.request(
      new Request('https://api.example.test/health', {
        headers: { 'x-request-id': 'too-short' },
      }),
      undefined,
      fixture.env,
    )
    expect(replaced.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9_-]{16,64}$/u)
    expect(replaced.headers.get('x-request-id')).not.toBe('too-short')
  })

  it('reports first-run state and completes setup only with the deployment secret and origin', async () => {
    const fixture = createFixture()
    const status = await fixture.app.request('/v1/setup', undefined, fixture.env)
    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({ status: 'required' })

    const denied = await postSetup(fixture, {
      ...setupRequest(),
      setupToken: 'wrong-setup-token-that-is-still-long-enough',
    })
    expect(denied.status).toBe(403)
    expect(fixture.completeInstallation).not.toHaveBeenCalled()

    const completed = await postSetup(fixture, setupRequest())
    expect(completed.status).toBe(201)
    expect(await completed.json()).toEqual({ status: 'complete' })
    expect(fixture.completeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        appOrigin: 'https://inbox.example.test',
        mailDomain: 'mail.example.test',
        mailboxAddress: 'inbox@mail.example.test',
        ownerEmail: 'owner@example.test',
      }),
    )

    const crossOrigin = await postSetup(fixture, setupRequest(), {
      origin: 'https://attacker.example.test',
    })
    expect(crossOrigin.status).toBe(403)
  })

  it('emits one safe structured completion event per request', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const fixture = createFixture()
      const healthRequestId = 'trace_health_12345'
      const deniedRequestId = 'trace_denied_12345'
      await fixture.app.request(
        new Request('https://api.example.test/health?secret=do-not-log', {
          headers: { 'x-request-id': healthRequestId },
        }),
        undefined,
        fixture.env,
      )
      const denied = await fixture.app.request(
        new Request('https://api.example.test/v1/mailboxes?token=do-not-log', {
          headers: { 'x-request-id': deniedRequestId },
        }),
        undefined,
        fixture.env,
      )
      expect(denied.status).toBe(401)

      const events = [...info.mock.calls, ...warn.mock.calls].map(
        ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
      )
      const completions = events.filter((event) => event['event'] === 'api.request.completed')
      expect(completions).toHaveLength(2)
      expect(completions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            environment: 'production',
            level: 'info',
            outcome: 'success',
            path: '/health',
            requestId: healthRequestId,
            service: 'api',
            status: 200,
          }),
          expect.objectContaining({
            environment: 'production',
            level: 'warn',
            outcome: 'client_error',
            path: '/v1/mailboxes',
            requestId: deniedRequestId,
            service: 'api',
            status: 401,
          }),
        ]),
      )
      expect(events.filter((event) => event['event'] === 'api.authorization.denied')).toHaveLength(
        1,
      )
      expect(events.every((event) => typeof event['timestamp'] === 'string')).toBe(true)
      expect(JSON.stringify(events)).not.toContain('do-not-log')
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('keeps magic-link request responses generic and builds links from APP_ORIGIN', async () => {
    const fixture = createFixture()
    const response = await postJson(
      fixture,
      '/v1/auth/magic-links',
      { email: 'OWNER@EXAMPLE.TEST' },
      { host: 'attacker.example' },
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'accepted' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(fixture.auth.magicDigest).toBe(await fixture.dependencies.digestToken(MAGIC_TOKEN))
    expect(fixture.auth.magicDigest).not.toContain(MAGIC_TOKEN)
    expect(fixture.mailRequests).toHaveLength(1)
    const delivery = (await fixture.mailRequests[0]?.json()) as {
      recipient: string
      textBody: string
    }
    expect(delivery.recipient).toBe('owner@example.test')
    expect(delivery.textBody).toContain(
      `https://inbox.example.test/auth/verify?token=${MAGIC_TOKEN}`,
    )
    expect(delivery.textBody).not.toContain('attacker.example')

    const unknown = createFixture({ knownUser: false })
    const unknownResponse = await postJson(unknown, '/v1/auth/magic-links', {
      email: 'unknown@example.test',
    })
    expect(unknownResponse.status).toBe(202)
    expect(await unknownResponse.json()).toEqual({ status: 'accepted' })
    expect(unknown.mailRequests).toHaveLength(0)

    const rateLimited = createFixture({ rateLimited: true })
    const limitedResponse = await postJson(rateLimited, '/v1/auth/magic-links', {
      email: 'owner@example.test',
    })
    expect(limitedResponse.status).toBe(202)
    expect(await limitedResponse.json()).toEqual({ status: 'accepted' })

    const mailFailure = createFixture({ mailFailure: true })
    const failedDelivery = await postJson(mailFailure, '/v1/auth/magic-links', {
      email: 'owner@example.test',
    })
    expect(failedDelivery.status).toBe(202)
    expect(await failedDelivery.json()).toEqual({ status: 'accepted' })
  })

  it('rate limits magic-link requests by both account and trusted Cloudflare source', async () => {
    const fixture = createFixture()
    const response = await postJsonFromCloudflare(
      fixture,
      '/v1/auth/magic-links',
      { email: 'OWNER@EXAMPLE.TEST' },
      '203.0.113.27',
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ status: 'accepted' })

    const accountDigest = (await sha256Hex('owner@example.test')).slice(0, 40)
    const sourceDigest = (await sha256Hex('203.0.113.27')).slice(0, 40)
    expect(rateLimitKeys(fixture)).toEqual([
      `magic-request:account:${accountDigest}`,
      `magic-request:source:${sourceDigest}`,
    ])

    const sourceLimited = createFixture({
      rateLimit: (key) => !key.startsWith('magic-request:source:'),
    })
    const limited = await postJsonFromCloudflare(
      sourceLimited,
      '/v1/auth/magic-links',
      { email: 'owner@example.test' },
      '203.0.113.27',
    )
    expect(limited.status).toBe(202)
    expect(await limited.json()).toEqual({ status: 'accepted' })
    expect(rateLimitKeys(sourceLimited)).toHaveLength(2)
    expect(sourceLimited.mailRequests).toHaveLength(0)
  })

  it('ignores spoofed forwarding headers outside the Cloudflare runtime', async () => {
    const fixture = createFixture()
    const response = await postJson(
      fixture,
      '/v1/auth/magic-links',
      { email: 'owner@example.test' },
      {
        'cf-connecting-ip': '198.51.100.19',
        'x-forwarded-for': '198.51.100.20',
      },
    )
    expect(response.status).toBe(202)
    expect(rateLimitKeys(fixture)).toContain('magic-request:source:unavailable')
  })

  it('shares a verification bucket across guessed tokens and IPv6 privacy addresses', async () => {
    const fixture = createFixture()
    const first = await postJsonFromCloudflare(
      fixture,
      '/v1/auth/magic-links/verify',
      { token: 'Y'.repeat(43) },
      '2001:db8:abcd:1234::1',
    )
    const second = await postJsonFromCloudflare(
      fixture,
      '/v1/auth/magic-links/verify',
      { token: 'Z'.repeat(43) },
      '2001:db8:abcd:1234:ffff::2',
    )
    expect(first.status).toBe(400)
    expect(second.status).toBe(400)
    expect(await errorCode(first)).toBe('magic_link_invalid')
    expect(await errorCode(second)).toBe('magic_link_invalid')

    const sourceDigest = (await sha256Hex('2001:db8:abcd:1234::/64')).slice(0, 40)
    expect(rateLimitKeys(fixture)).toEqual([
      `magic-verify:source:${sourceDigest}`,
      `magic-verify:source:${sourceDigest}`,
    ])
  })

  it('validates content type and body size before parsing credentials', async () => {
    const fixture = createFixture()
    const unsupported = await fixture.app.request(
      '/v1/auth/magic-links',
      { body: JSON.stringify({ email: 'owner@example.test' }), method: 'POST' },
      fixture.env,
    )
    expect(unsupported.status).toBe(415)
    expect(await errorCode(unsupported)).toBe('unsupported_media_type')

    const oversized = await fixture.app.request(
      '/v1/auth/magic-links',
      {
        body: JSON.stringify({ email: `${'x'.repeat(70_000)}@example.test` }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
      fixture.env,
    )
    expect(oversized.status).toBe(413)
    expect(await errorCode(oversized)).toBe('request_too_large')
  })

  it('consumes a magic link once, issues a hardened cookie, and revokes it on logout', async () => {
    const fixture = createFixture()
    await postJson(fixture, '/v1/auth/magic-links', { email: 'owner@example.test' })
    const verified = await postJson(fixture, '/v1/auth/magic-links/verify', {
      token: MAGIC_TOKEN,
    })
    expect(verified.status).toBe(200)
    expect(await verified.json()).toMatchObject({
      authenticated: true,
      principal: { email: 'owner@example.test', userId: USER_ID },
      session: { id: SESSION_ID },
    })
    const cookie = verified.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(`__Host-simple-inbox-session=${SESSION_TOKEN}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`)
    expect(cookie).not.toContain('Domain=')

    const replay = await postJson(fixture, '/v1/auth/magic-links/verify', {
      token: MAGIC_TOKEN,
    })
    expect(replay.status).toBe(400)
    expect(await errorCode(replay)).toBe('magic_link_invalid')

    const session = await fixture.app.request(
      '/v1/auth/session',
      { headers: { cookie: cookiePair(cookie) } },
      fixture.env,
    )
    expect(await session.json()).toMatchObject({ authenticated: true })

    const rejectedLogout = await fixture.app.request(
      '/v1/auth/logout',
      { headers: { cookie: cookiePair(cookie), 'sec-fetch-site': 'cross-site' }, method: 'POST' },
      fixture.env,
    )
    expect(rejectedLogout.status).toBe(403)
    expect(await errorCode(rejectedLogout)).toBe('csrf_rejected')

    const logout = await fixture.app.request(
      '/v1/auth/logout',
      {
        headers: {
          cookie: cookiePair(cookie),
          origin: 'https://inbox.example.test',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      },
      fixture.env,
    )
    expect(logout.status).toBe(204)
    expect(fixture.auth.revoked).toBe(true)
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('uses a clearly separate non-secure cookie locally and allows only one concurrent verify', async () => {
    const local = createFixture()
    local.env.ENVIRONMENT = 'local'
    local.env.APP_ORIGIN = 'http://localhost:3000'
    await postJson(local, '/v1/auth/magic-links', { email: 'owner@example.test' })
    const localVerify = await postJson(local, '/v1/auth/magic-links/verify', {
      token: MAGIC_TOKEN,
    })
    const localCookie = localVerify.headers.get('set-cookie') ?? ''
    expect(localCookie).toContain(`simple-inbox-development-session=${SESSION_TOKEN}`)
    expect(localCookie).not.toContain('__Host-')
    expect(localCookie).not.toContain('Secure')

    const staging = createFixture()
    staging.env.ENVIRONMENT = 'staging'
    staging.env.APP_ORIGIN = 'https://inbox-staging.example.test'
    await postJson(staging, '/v1/auth/magic-links', { email: 'owner@example.test' })
    const stagingVerify = await postJson(staging, '/v1/auth/magic-links/verify', {
      token: MAGIC_TOKEN,
    })
    const stagingCookie = stagingVerify.headers.get('set-cookie') ?? ''
    expect(stagingCookie).toContain(`__Host-simple-inbox-session=${SESSION_TOKEN}`)
    expect(stagingCookie).toContain('Secure')

    const concurrent = createFixture()
    await postJson(concurrent, '/v1/auth/magic-links', { email: 'owner@example.test' })
    const results = await Promise.all([
      postJson(concurrent, '/v1/auth/magic-links/verify', { token: MAGIC_TOKEN }),
      postJson(concurrent, '/v1/auth/magic-links/verify', { token: MAGIC_TOKEN }),
    ])
    expect(results.map((response) => response.status).sort((left, right) => left - right)).toEqual([
      200, 400,
    ])

    const tampered = createFixture()
    await postJson(tampered, '/v1/auth/magic-links', { email: 'owner@example.test' })
    const invalid = await postJson(tampered, '/v1/auth/magic-links/verify', {
      token: 'Z'.repeat(43),
    })
    expect(invalid.status).toBe(400)
    expect(await errorCode(invalid)).toBe('magic_link_invalid')
  })

  it('enforces cookie CSRF while allowing correctly scoped bearer tokens', async () => {
    const fixture = createFixture({ apiTokenScopes: 4 })
    const cookie = `__Host-simple-inbox-session=${SESSION_TOKEN}`
    const cookieMutation = await fixture.app.request(
      `/v1/mailboxes/${MAILBOX_ID}`,
      {
        body: JSON.stringify({ senderAlias: 'Support' }),
        headers: { 'content-type': 'application/json', cookie },
        method: 'PATCH',
      },
      fixture.env,
    )
    expect(cookieMutation.status).toBe(403)
    expect(await errorCode(cookieMutation)).toBe('csrf_rejected')

    const bearerMutation = await fixture.app.request(
      `/v1/mailboxes/${MAILBOX_ID}`,
      {
        body: JSON.stringify({ senderAlias: 'Support' }),
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          'content-type': 'application/json',
        },
        method: 'PATCH',
      },
      fixture.env,
    )
    expect(bearerMutation.status).toBe(200)
    expect(await bearerMutation.json()).toMatchObject({ senderAlias: 'Support' })

    const readOnly = createFixture({ apiTokenScopes: 1 })
    const forbidden = await readOnly.app.request(
      `/v1/mailboxes/${MAILBOX_ID}`,
      {
        body: JSON.stringify({ senderAlias: 'Support' }),
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          'content-type': 'application/json',
        },
        method: 'PATCH',
      },
      readOnly.env,
    )
    expect(forbidden.status).toBe(403)
  })

  it('projects mailbox/thread DTOs and applies folder and mutation semantics', async () => {
    const fixture = createFixture()
    const cookie = `__Host-simple-inbox-session=${SESSION_TOKEN}`
    const mailboxes = await fixture.app.request(
      '/v1/mailboxes',
      { headers: { cookie } },
      fixture.env,
    )
    expect(mailboxes.status).toBe(200)
    expect(await mailboxes.json()).toMatchObject({
      mailboxes: [
        {
          counts: { all: 1, archive: 0, needsReply: 1, sent: 0, unread: 1 },
          forwardTo: 'owner@example.test',
          id: MAILBOX_ID,
        },
      ],
    })

    const threads = await fixture.app.request(
      `/v1/threads?mailboxId=${MAILBOX_ID}&folder=needs-reply&unread=1&limit=10`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(threads.status).toBe(200)
    expect(await threads.json()).toMatchObject({
      items: [{ id: THREAD_ID, workflowState: 'needs_reply' }],
      nextCursor: null,
    })
    expect(fixture.inbox.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'needs_reply', limit: 10, unreadOnly: true }),
    )

    const detail = await fixture.app.request(
      `/v1/threads/${THREAD_ID}`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      messages: [{ id: MESSAGE_ID, textBody: 'Body' }],
      thread: { id: THREAD_ID, unreadCount: 1 },
    })

    for (const [method, path] of [
      ['POST', `/v1/threads/${THREAD_ID}/read`],
      ['POST', `/v1/threads/${THREAD_ID}/archive`],
      ['DELETE', `/v1/threads/${THREAD_ID}/archive`],
    ] as const) {
      const mutation = await fixture.app.request(
        path,
        {
          headers: {
            cookie,
            origin: 'https://inbox.example.test',
            'sec-fetch-site': 'same-origin',
          },
          method,
        },
        fixture.env,
      )
      expect(mutation.status).toBe(204)
    }
  })

  it('returns indistinguishable membership-scoped 404s without touching R2', async () => {
    const fixture = createFixture({ rawMessage: undefined, threadDetail: undefined })
    const cookie = `__Host-simple-inbox-session=${SESSION_TOKEN}`
    const thread = await fixture.app.request(
      `/v1/threads/${THREAD_ID}`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(thread.status).toBe(404)
    expect(await errorCode(thread)).toBe('thread_not_found')

    const raw = await fixture.app.request(
      `/v1/messages/${MESSAGE_ID}/raw`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(raw.status).toBe(404)
    expect(await errorCode(raw)).toBe('message_not_found')
    expect(fixture.r2Get).not.toHaveBeenCalled()
  })

  it('surfaces only the safe manual-confirmation classification for unknown delivery', async () => {
    const failure = {
      retryability: 'manual_confirmation_required' as const,
      safeErrorCode: 'provider_send_unknown',
    }
    const fixture = createFixture({ threadFailure: failure })
    const response = await fixture.app.request(
      `/v1/threads/${THREAD_ID}`,
      { headers: { cookie: `__Host-simple-inbox-session=${SESSION_TOKEN}` } },
      fixture.env,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      messages: [{ failure, forwardState: 'unknown' }],
    })
  })

  it('streams authorized raw messages and extracts verified attachments privately', async () => {
    const rawEmail = new TextEncoder().encode(
      [
        'From: Sender <sender@example.test>',
        'To: owner@example.test',
        'Subject: Fixture',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="fixture"',
        '',
        '--fixture',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Body',
        '--fixture',
        'Content-Type: text/plain',
        'Content-Disposition: attachment; filename="report.txt"',
        'Content-Transfer-Encoding: base64',
        '',
        'SGVsbG8=',
        '--fixture--',
        '',
      ].join('\r\n'),
    )
    const fixture = createFixture({ attachmentRaw: rawEmail })
    const cookie = `__Host-simple-inbox-session=${SESSION_TOKEN}`
    const raw = await fixture.app.request(
      `/v1/messages/${MESSAGE_ID}/raw`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('message/rfc822')
    expect(raw.headers.get('cache-control')).toBe('private, no-store')
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await raw.arrayBuffer())).toEqual(rawEmail)

    const attachment = await fixture.app.request(
      `/v1/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
      { headers: { cookie } },
      fixture.env,
    )
    expect(attachment.status).toBe(200)
    expect(await attachment.text()).toBe('Hello')
    expect(attachment.headers.get('content-disposition')).toContain('filename="report.txt"')
    expect(attachment.headers.get('cache-control')).toBe('private, no-store')

    const conditional = await fixture.app.request(
      `/v1/messages/${MESSAGE_ID}/attachments/${ATTACHMENT_ID}`,
      { headers: { cookie, 'if-none-match': `"${RAW_SHA256}-0"` } },
      fixture.env,
    )
    expect(conditional.status).toBe(304)
  })

  it('fails closed when an R2 object does not match the authorized D1 digest', async () => {
    const fixture = createFixture({ r2Sha256: 'e'.repeat(64) })
    const response = await fixture.app.request(
      `/v1/messages/${MESSAGE_ID}/raw`,
      { headers: { cookie: `__Host-simple-inbox-session=${SESSION_TOKEN}` } },
      fixture.env,
    )

    expect(response.status).toBe(500)
    expect(await errorCode(response)).toBe('internal_error')
  })

  it('derives trusted send context and never forwards spoofed actor headers', async () => {
    const fixture = createFixture()
    const body = new FormData()
    body.append('mailboxId', MAILBOX_ID)
    body.append('to', 'Recipient <recipient@example.test>')
    body.append('subject', 'Hello')
    body.append('body', 'A bounded message')
    body.append('format', 'plain')
    body.append('attachments', new File(['hello'], 'note.txt', { type: 'text/plain' }))
    const response = await fixture.app.request(
      '/v1/messages',
      {
        body,
        headers: {
          cookie: `__Host-simple-inbox-session=${SESSION_TOKEN}`,
          'idempotency-key': 'send-test-key-0001',
          origin: 'https://inbox.example.test',
          'sec-fetch-site': 'same-origin',
          'x-actor-user-id': 'attacker',
        },
        method: 'POST',
      },
      fixture.env,
    )
    expect(response.status, await response.clone().text()).toBe(201)
    expect(await response.json()).toMatchObject({ id: SEND_ID, state: 'sent' })
    const internal = fixture.mailRequests.at(-1)
    expect(internal?.headers.get('x-actor-user-id')).toBeNull()
    const internalForm = await internal?.formData()
    const metadata = internalForm?.get('metadata')
    expect(typeof metadata).toBe('string')
    if (typeof metadata !== 'string') throw new TypeError('Expected internal send metadata.')
    const request = JSON.parse(metadata) as {
      actor: { mailboxId: string; userId: string }
      requestDigest: string
      requestId: string
    }
    expect(request.actor).toMatchObject({ mailboxId: MAILBOX_ID, userId: USER_ID })
    expect(request.requestDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(internalForm?.getAll('attachments')).toHaveLength(1)
  })

  it('preserves a deterministic mail-worker size rejection as 413', async () => {
    const fixture = createFixture({ sendFailureStatus: 413 })
    const body = new FormData()
    body.append('mailboxId', MAILBOX_ID)
    body.append('to', 'recipient@example.test')
    body.append('subject', 'Hello')
    body.append('body', 'A bounded request rejected by the provider projection limit')
    body.append('format', 'plain')
    const response = await fixture.app.request(
      '/v1/messages',
      {
        body,
        headers: {
          cookie: `__Host-simple-inbox-session=${SESSION_TOKEN}`,
          'idempotency-key': 'send-test-key-oversize',
          origin: 'https://inbox.example.test',
          'sec-fetch-site': 'same-origin',
        },
        method: 'POST',
      },
      fixture.env,
    )

    expect(response.status).toBe(413)
    expect(await errorCode(response)).toBe('request_too_large')
  })
})

function createFixture(
  options: {
    apiTokenScopes?: number
    attachmentRaw?: Uint8Array
    knownUser?: boolean
    mailFailure?: boolean
    rateLimit?: (key: string) => boolean | Promise<boolean>
    rateLimited?: boolean
    rawMessage?: object | undefined
    r2Sha256?: string
    sendFailureStatus?: number
    threadDetail?: object | undefined
    threadFailure?: {
      retryability: 'manual_confirmation_required'
      safeErrorCode: string
    }
  } = {},
) {
  const attachmentRaw = options.attachmentRaw ?? new TextEncoder().encode('raw fixture')
  const tokenDigest = (token: string) => sha256Hex(`test:${token}`)
  const authState = {
    consumed: false,
    magicDigest: undefined as string | undefined,
    revoked: false,
    sessionDigest: undefined as string | undefined,
  }
  const auth: AuthRepositoryPort = {
    async consumeMagicLink(input) {
      if (authState.consumed || input.tokenDigest !== authState.magicDigest) return undefined
      authState.consumed = true
      authState.sessionDigest = input.sessionTokenDigest
      return {
        email: 'owner@example.test',
        expiresAt: input.sessionExpiresAt,
        sessionId: SESSION_ID,
        userId: USER_ID,
      }
    },
    async findApiToken(digest, requiredScope) {
      const bit = { read: 1, send: 2, settings: 4 }[requiredScope]
      if (
        digest !== (await tokenDigest(API_TOKEN)) ||
        ((options.apiTokenScopes ?? 7) & bit) !== bit
      ) {
        return undefined
      }
      return {
        email: 'owner@example.test',
        scopes: options.apiTokenScopes ?? 7,
        tokenId: '01996f7a-7bcd-7abc-8def-8123456789ab',
        userId: USER_ID,
      }
    },
    async findSession(digest) {
      if (authState.revoked || digest !== (await tokenDigest(SESSION_TOKEN))) return undefined
      return {
        email: 'owner@example.test',
        expiresAt: EXPIRES_AT,
        sessionId: SESSION_ID,
        userId: USER_ID,
      }
    },
    async revokeSession(digest) {
      if (digest !== (await tokenDigest(SESSION_TOKEN))) return false
      authState.revoked = true
      return true
    },
    async tryCreateMagicLink(input) {
      if (options.knownUser === false) return false
      authState.magicDigest = input.tokenDigest
      return true
    },
  }

  let forwardTo: string | null = 'owner@example.test'
  let senderAlias: string | null = null
  const mailbox = {
    activeCount: 1,
    address: 'inbox@example.test',
    archiveCount: 0,
    createdAt: NOW,
    forwardTo,
    id: MAILBOX_ID,
    needsReplyCount: 1,
    role: 'owner',
    senderAlias,
    sentCount: 0,
    unreadCount: 1,
    updatedAt: NOW,
  }
  const rawMetadata =
    options.rawMessage === undefined && 'rawMessage' in options
      ? undefined
      : {
          id: MESSAGE_ID,
          mailboxId: MAILBOX_ID,
          rawR2Key: 'raw/inbound/fixture.eml',
          rawSha256: RAW_SHA256,
          rawSize: attachmentRaw.byteLength,
          threadId: THREAD_ID,
        }
  const attachmentMetadata = {
    contentId: null,
    displayFilename: 'report.txt',
    disposition: 'attachment',
    id: ATTACHMENT_ID,
    mailboxId: MAILBOX_ID,
    mediaType: 'text/plain',
    messageId: MESSAGE_ID,
    mimeOrdinal: 0,
    rawR2Key: 'raw/inbound/fixture.eml',
    rawSha256: RAW_SHA256,
    rawSize: attachmentRaw.byteLength,
    size: 5,
  }
  const threadSummary = {
    archivedAt: null,
    attachmentCount: 0,
    id: THREAD_ID,
    lastMessageAt: NOW,
    lastMessageDirection: 'inbound',
    lastMessagePreview: 'Body',
    lastSenderAddress: 'sender@example.test',
    mailboxId: MAILBOX_ID,
    messageCount: 1,
    normalizedSubject: 'fixture',
    participants: [{ address: 'sender@example.test', displayName: 'Sender' }],
    subject: 'Fixture',
    tags: [{ name: 'priority' }],
    unreadCount: 1,
    workflowState: 'needs_reply',
  }
  const threadDetail = {
    messages: [
      {
        attachments: [],
        direction: 'inbound',
        failure: options.threadFailure ?? null,
        forwardState: options.threadFailure === undefined ? 'forwarded' : 'unknown',
        from: { address: 'sender@example.test', displayName: 'Sender' },
        htmlBody: null,
        htmlPolicy: 'none',
        id: MESSAGE_ID,
        inReplyTo: null,
        internetMessageId: '<fixture@example.test>',
        mailboxId: MAILBOX_ID,
        preview: 'Body',
        rawAvailable: true,
        rawSize: attachmentRaw.byteLength,
        readAt: null,
        receivedAt: NOW,
        recipients: [
          {
            address: 'inbox@example.test',
            displayName: null,
            kind: 'to',
            position: 0,
          },
        ],
        references: [],
        sendState: 'not_applicable',
        sentAt: NOW,
        subject: 'Fixture',
        textBody: 'Body',
        threadId: THREAD_ID,
      },
    ],
    thread: threadSummary,
  }
  const inbox = {
    getAttachment: vi.fn(async () => attachmentMetadata),
    getMailboxSettings: vi.fn(async (mailboxId: string) =>
      mailboxId === MAILBOX_ID
        ? {
            address: mailbox.address,
            forwardTo,
            id: mailbox.id,
            senderAlias,
            updatedAt: NOW,
          }
        : undefined,
    ),
    getRawMessage: vi.fn(async () => rawMetadata),
    getThread: vi.fn(async () => threadSummary),
    getThreadDetail: vi.fn(async () =>
      options.threadDetail === undefined && 'threadDetail' in options
        ? undefined
        : ((options.threadDetail ?? threadDetail) as never),
    ),
    listMailboxes: vi.fn(async () => [{ ...mailbox, forwardTo, senderAlias }]),
    listThreads: vi.fn(async () => ({ items: [threadSummary], nextCursor: null })),
    markThreadRead: vi.fn(async () => true),
    searchThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
    setThreadArchived: vi.fn(async () => true),
    updateMailboxSettings: vi.fn(
      async (
        _mailboxId: string,
        values: { forwardTo?: string | null; senderAlias?: string | null },
      ) => {
        if (values.forwardTo !== undefined) forwardTo = values.forwardTo
        if (values.senderAlias !== undefined) senderAlias = values.senderAlias
        return true
      },
    ),
  } as unknown as InboxRepositoryPort

  const r2Get = vi.fn(async () => ({
    body: new Response(Uint8Array.from(attachmentRaw).buffer).body,
    customMetadata: { sha256: options.r2Sha256 ?? RAW_SHA256 },
    size: attachmentRaw.byteLength,
  }))
  const mailRequests: Request[] = []
  const mail = {
    async fetch(request: Request) {
      if (request.url.endsWith('/internal/v1/auth/magic-link')) {
        mailRequests.push(request.clone() as unknown as Request)
        return new Response(null, { status: options.mailFailure === true ? 503 : 202 })
      }
      if (request.url.endsWith('/internal/v1/send')) {
        mailRequests.push(request.clone() as unknown as Request)
        if (options.sendFailureStatus !== undefined) {
          return Response.json(
            { error: { code: 'request_too_large', message: 'Synthetic rejection.' } },
            { status: options.sendFailureStatus },
          )
        }
        return Response.json(
          {
            acceptedAt: new Date(NOW).toISOString(),
            completedAt: new Date(NOW).toISOString(),
            id: SEND_ID,
            idempotencyKey: 'send-test-key-0001',
            messageId: MESSAGE_ID,
            retryability: 'not_retryable',
            safeErrorCode: null,
            state: 'sent',
            threadId: THREAD_ID,
          },
          { status: 201 },
        )
      }
      return Response.json({ ok: true, service: 'mail' })
    },
  } as unknown as Fetcher
  const rateLimit = vi.fn(async ({ key }: { key: string }) => ({
    success:
      options.rateLimit === undefined ? options.rateLimited !== true : await options.rateLimit(key),
  }))
  const env = {
    APP_ORIGIN: 'https://inbox.example.test',
    AUTH_RATE_LIMIT: {
      limit: rateLimit,
    } as unknown as RateLimit,
    AUTH_TOKEN_PEPPER: 'p'.repeat(32),
    DB: {} as D1Database,
    ENVIRONMENT: 'production',
    MAIL: mail,
    MAIL_DOMAIN: 'example.test',
    OWNER_EMAIL: 'owner@example.test',
    RAW_EMAILS: { get: r2Get } as unknown as R2Bucket,
    RAW_EMAIL_RETENTION_DAYS: '365',
    SETUP_TOKEN: 'setup-secret-00000000000000000000000000000000',
  } satisfies ApiBindings
  const tokenQueue = [MAGIC_TOKEN, SESSION_TOKEN]
  const idQueue = [MAGIC_LINK_ID, SESSION_ID]
  const completeInstallation = vi.fn(async (input: CompleteInstallationInput) => ({
    created: true,
    settings: {
      applicationRecordRetentionDays: input.applicationRecordRetentionDays,
      appOrigin: input.appOrigin,
      completedAt: input.completedAt,
      mailDomain: input.mailDomain,
      mailboxAddress: input.mailboxAddress,
      ownerEmail: input.ownerEmail,
      rawEmailRetentionDays: input.rawEmailRetentionDays,
      retentionBatchSize: input.retentionBatchSize,
      setupVersion: 1 as const,
    },
  }))
  const dependencies = {
    authRepository: () => auth,
    digestToken: (token: string) => tokenDigest(token),
    generateId: () => idQueue.shift() ?? SESSION_ID,
    generateToken: () => tokenQueue.shift() ?? SESSION_TOKEN,
    inboxRepository: () => inbox,
    installationRepository: () => ({
      complete: completeInstallation,
      getStatus: async () => ({ status: 'required' as const }),
    }),
    now: () => NOW,
  } satisfies ApiDependencies

  return {
    app: createApiApp(dependencies),
    auth: authState,
    dependencies,
    completeInstallation,
    env,
    inbox,
    mailRequests,
    rateLimit,
    r2Get,
  }
}

function setupRequest() {
  return {
    applicationRecordRetentionDays: 90,
    mailDomain: 'mail.example.test',
    mailboxAddress: 'inbox@mail.example.test',
    ownerEmail: 'owner@example.test',
    rawEmailRetentionDays: 30,
    retentionBatchSize: 100,
    setupToken: 'setup-secret-00000000000000000000000000000000',
  }
}

function postSetup(
  fixture: ReturnType<typeof createFixture>,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postJson(fixture, '/v1/setup', body, {
    origin: 'https://inbox.example.test',
    'sec-fetch-site': 'same-origin',
    'x-forwarded-host': 'inbox.example.test',
    'x-forwarded-proto': 'https',
    ...headers,
  })
}

async function postJson(
  fixture: ReturnType<typeof createFixture>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fixture.app.request(
    path,
    {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...headers },
      method: 'POST',
    },
    fixture.env,
  )
}

async function postJsonFromCloudflare(
  fixture: ReturnType<typeof createFixture>,
  path: string,
  body: unknown,
  connectingIp: string,
): Promise<Response> {
  const encodedBody = JSON.stringify(body)
  const request = new Request(new URL(path, 'https://api.example.test'), {
    body: encodedBody,
    headers: {
      'cf-connecting-ip': connectingIp,
      'content-length': String(new TextEncoder().encode(encodedBody).byteLength),
      'content-type': 'application/json',
    },
    method: 'POST',
  })
  Object.defineProperty(request, 'cf', {
    configurable: true,
    value: { colo: 'SIN' },
  })
  return fixture.app.fetch(request, fixture.env)
}

function rateLimitKeys(fixture: ReturnType<typeof createFixture>): string[] {
  return fixture.rateLimit.mock.calls.map(([input]) => input.key)
}

async function errorCode(response: Response): Promise<string | undefined> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0] ?? ''
}
