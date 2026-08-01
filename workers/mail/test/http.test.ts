import { InternalSendRequestSchema } from '@cloudflare-inbox/contracts'
import { computeIdempotencyRequestDigest } from '@cloudflare-inbox/mail-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createMailApp } from '../src/index'
import {
  MAILBOX_ID,
  NOW,
  OWNER_USER_ID,
  SEND_ID,
  THREAD_ID,
  FakeMailStore,
  createDependencies,
  createFakeEnvironment,
} from './support/fakes'

describe('mail internal HTTP boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('returns the strict internal health contract and preserves valid request IDs', async () => {
    const app = createMailApp()
    const response = await app.request(
      new Request('https://mail.test/internal/health', {
        headers: { 'x-request-id': 'trace_phase0_1234' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('trace_phase0_1234')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ ok: true, service: 'mail' })
  })

  it('delivers a validated magic link through the isolated binding boundary', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const app = createMailApp(createDependencies(store))
    const response = await request(app, runtime.env, '/internal/v1/auth/magic-link', {
      body: JSON.stringify({
        htmlBody: '<p>Synthetic sign in</p>',
        recipient: 'owner@example.test',
        requestId: 'trace_magiclink_01',
        subject: 'Synthetic sign in',
        textBody: 'Synthetic sign in',
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })

    expect(response.status).toBe(202)
    expect(runtime.sent).toEqual([
      expect.objectContaining({
        from: 'no-reply@example.test',
        to: 'owner@example.test',
      }),
    ])
  })

  it('requires the optional operator secret on every command/read endpoint', async () => {
    const secret = 's'.repeat(32)
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment({ internalSecret: secret })
    const app = createMailApp(createDependencies(store))
    const missing = await request(app, runtime.env, '/internal/v1/sends/synthetic-send-key-0001')
    const authorized = await request(app, runtime.env, '/internal/v1/auth/magic-link', {
      body: JSON.stringify({
        htmlBody: '<p>Synthetic sign in</p>',
        recipient: 'owner@example.test',
        requestId: 'trace_magiclink_02',
        subject: 'Synthetic sign in',
        textBody: 'Synthetic sign in',
      }),
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    })

    expect(missing.status).toBe(401)
    expect(await missing.json()).toMatchObject({ error: { code: 'unauthorized' } })
    expect(authorized.status).toBe(202)
  })

  it('submits multipart sends and exposes the prior result by idempotency key', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const app = createMailApp(createDependencies(store))
    const command = {
      message: {
        body: 'Synthetic body',
        format: 'plain' as const,
        mailboxId: MAILBOX_ID,
        subject: 'Synthetic subject',
        to: [{ address: 'recipient@receiver.example.test' }],
      },
      mode: 'new' as const,
    }
    const requestDigest = await computeIdempotencyRequestDigest({
      attachments: [],
      command,
      version: 1,
    })
    const internal = InternalSendRequestSchema.parse({
      actor: {
        authKind: 'session',
        mailboxId: MAILBOX_ID,
        scopes: ['send'],
        userId: OWNER_USER_ID,
      },
      command,
      idempotencyKey: 'synthetic-http-send-0001',
      requestDigest,
      requestId: 'trace_http_send_001',
    })
    const form = new FormData()
    form.set('request', JSON.stringify(internal))
    const submitted = await request(app, runtime.env, '/internal/v1/send', {
      body: form,
      method: 'POST',
    })
    const status = await request(app, runtime.env, '/internal/v1/sends/synthetic-http-send-0001')

    expect(submitted.status).toBe(201)
    expect(await submitted.json()).toMatchObject({ state: 'sent' })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      idempotencyKey: 'synthetic-http-send-0001',
      state: 'sent',
    })
  })

  it('rejects wrong content types and returns stable no-secret errors', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const app = createMailApp(createDependencies(store))
    const wrongType = await request(app, runtime.env, '/internal/v1/auth/magic-link', {
      body: '{}',
      headers: { 'content-type': 'text/plain' },
      method: 'POST',
    })
    const absent = await request(app, runtime.env, '/internal/v1/does-not-exist')

    expect(wrongType.status).toBe(415)
    expect(await wrongType.json()).toMatchObject({
      error: { code: 'unsupported_media_type', requestId: expect.any(String) },
    })
    expect(absent.status).toBe(404)
    expect(await absent.json()).toMatchObject({ error: { code: 'not_found' } })
    expect(
      JSON.stringify(await (await request(app, runtime.env, '/internal/v1/missing')).json()),
    ).not.toContain('DB')
  })

  it('serializes a pre-existing unknown status without resending', async () => {
    const store = new FakeMailStore()
    store.sends.set('synthetic-send-key-0001', {
      actorUserId: OWNER_USER_ID,
      attemptCount: 1,
      createdAt: NOW,
      id: SEND_ID,
      idempotencyKey: 'synthetic-send-key-0001',
      lastAttemptedAt: NOW,
      mailboxId: MAILBOX_ID,
      messageId: null,
      providerErrorCode: 'provider_send_unknown',
      providerMessageId: null,
      requestDigest: 'a'.repeat(64),
      retryability: 'manual_confirmation_required',
      state: 'unknown',
      threadId: THREAD_ID,
      updatedAt: NOW,
    })
    const runtime = createFakeEnvironment()
    const app = createMailApp(createDependencies(store))
    const response = await request(app, runtime.env, '/internal/v1/sends/synthetic-send-key-0001')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      completedAt: null,
      messageId: null,
      safeErrorCode: 'provider_send_unknown',
      state: 'unknown',
    })
    expect(runtime.sent).toEqual([])
  })
})

type MailApp = ReturnType<typeof createMailApp>

function request(
  app: MailApp,
  env: Parameters<MailApp['request']>[2],
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.request(`https://mail.internal${path}`, init, env))
}
