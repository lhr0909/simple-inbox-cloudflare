import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeIdempotencyRequestDigest,
  computeInboundIngestDigest,
  sha256Hex,
} from '@cloudflare-inbox/mail-core'

import { captureInboundEmail } from '../src/services/inbound'
import { parseInboundMime } from '../src/services/mime'
import inboundFixture from './fixtures/inbound-with-attachment.eml?raw'
import malformedFixture from './fixtures/malformed.eml?raw'
import aliasFixture from './fixtures/reply-alias.eml?raw'
import {
  ALIAS_TOKEN,
  INBOUND_MESSAGE_ID,
  MAILBOX_ID,
  NOW,
  OWNER_USER_ID,
  SEND_ID,
  THREAD_ID,
  FakeMailStore,
  createDependencies,
  createFakeEnvironment,
  createForwardableMessage,
} from './support/fakes'

const encode = (value: string) => new TextEncoder().encode(value)

describe('inbound email capture', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it.each([false, true])(
    'forwards original HTML only when enabled (%s), preserving inline images and safe storage',
    async (enabled) => {
      const store = new FakeMailStore()
      store.forwardHtml = enabled
      const runtime = createFakeEnvironment()
      const originalHtml =
        '<table><tr><td style="color:red"><b>Formatted offer</b><img src="cid:logo"></td></tr></table>'
      const raw = encode(
        [
          'From: sender@example.test',
          'To: support@example.test',
          'Subject: HTML preference',
          'Message-ID: <html-preference@example.test>',
          'MIME-Version: 1.0',
          'Content-Type: multipart/related; boundary="html-test"',
          '',
          '--html-test',
          'Content-Type: text/html; charset=utf-8',
          '',
          originalHtml,
          '--html-test',
          'Content-Type: image/png',
          'Content-ID: <logo>',
          'Content-Disposition: inline; filename="logo.png"',
          'Content-Transfer-Encoding: base64',
          '',
          'iVBORw==',
          '--html-test--',
          '',
        ].join('\r\n'),
      )
      const input = createForwardableMessage(raw)
      await captureInboundEmail(
        input.message,
        runtime.env,
        createDependencies(store),
        'trace_html_forward_0001',
      )
      expect(runtime.sent).toHaveLength(1)
      const delivery = runtime.sent[0] as {
        html: string
        attachments: Array<{ contentId?: string }>
      }
      if (enabled) expect(delivery.html).toContain(originalHtml)
      else expect(delivery.html).not.toMatch(/<table|<img|style=/u)
      expect(delivery.attachments[0]?.contentId).toBe('logo')
      expect(store.projects[0]?.message.htmlBody).not.toMatch(/<table|<img|style=/u)
      expect(store.projects[0]?.message.htmlPolicy).toBe('sanitized')
      expect([...runtime.objects.values()][0]).toEqual(raw)
    },
  )

  it('preserves exact raw bytes before parsing/projection and forwards only after durable state', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    const runtime = createFakeEnvironment({ events })
    const raw = encode(inboundFixture)
    const input = createForwardableMessage(raw)

    const result = await captureInboundEmail(
      input.message,
      runtime.env,
      createDependencies(store),
      'trace_inbound_0001',
    )

    expect(result.kind).toBe('captured')
    expect(input.rejected).toEqual([])
    expect(store.projects).toHaveLength(1)
    const projection = store.projects[0]
    expect(projection?.message).toMatchObject({
      direction: 'inbound',
      forwardState: 'forwarded',
      fromAddress: 'alice@sender.example.test',
      ingestDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      rawSize: raw.byteLength,
      subject: 'Synthetic support request',
    })
    expect(projection?.attachments).toEqual([
      expect.objectContaining({
        displayFilename: 'notes.txt',
        mediaType: 'text/plain',
        mimeOrdinal: 0,
        size: 21,
      }),
    ])
    const stored = runtime.objects.get(projection?.message.rawR2Key ?? '')
    expect(stored).toEqual(raw)
    expect([...store.aliases.values()][0]?.relayDestination).toBe(
      'alice-replies@sender.example.test',
    )
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatchObject({
      from: {
        email: 'support@example.test',
        name: 'Alice Example (alice@sender.example.test)',
      },
      replyTo: `${ALIAS_TOKEN}@example.test`,
      subject: 'Synthetic support request',
      to: 'owner@example.test',
    })
    expect(events.indexOf('r2:put')).toBeLessThan(events.indexOf('db:project-inbound'))
    expect(events.indexOf('db:project-inbound')).toBeLessThan(events.indexOf('db:claim-forward'))
    expect(events.indexOf('db:claim-forward')).toBeLessThan(events.indexOf('email:send'))
    const structured = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    expect(structured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: 'test',
          event: 'mail.inbound.received',
          outcome: 'received',
          requestId: 'trace_inbound_0001',
        }),
        expect.objectContaining({ event: 'mail.inbound.persisted', outcome: 'completed' }),
      ]),
    )
    const serialized = JSON.stringify(structured)
    expect(serialized).not.toContain('alice@sender.example.test')
    expect(serialized).not.toContain('raw/inbound/')
    expect(serialized).not.toContain('Synthetic support request')
    expect(serialized).not.toContain('Hello from the synthetic sender')
  })

  it('captures without an alias or provider send when forwarding is explicitly disabled', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    store.forwardTo = null
    const runtime = createFakeEnvironment({ events })
    const raw = encode(inboundFixture)

    const result = await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      createDependencies(store),
      'trace_forward_disabled_0001',
    )

    expect(result.kind).toBe('captured')
    expect(store.projects[0]?.message).toMatchObject({
      forwardAttemptedAt: null,
      forwardState: 'not_applicable',
      providerErrorCode: null,
    })
    expect(store.aliases.size).toBe(0)
    expect(runtime.sent).toEqual([])
    expect(events).not.toContain('db:ensure-alias')
    expect(events).not.toContain('email:send')
  })

  it('captures a catch-all recipient outside the primary domain and forwards as that mailbox', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const input = createForwardableMessage(raw, { to: 'campaigns@other.example.test' })

    const result = await captureInboundEmail(
      input.message,
      runtime.env,
      createDependencies(store),
      'trace_catch_all_domain_0001',
    )

    expect(result.kind).toBe('captured')
    expect(input.rejected).toEqual([])
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatchObject({
      from: {
        email: 'campaigns@other.example.test',
        name: 'Alice Example (alice@sender.example.test)',
      },
      replyTo: `${ALIAS_TOKEN}@other.example.test`,
      to: 'owner@example.test',
    })
  })

  it('opens an unallocated opaque catch-all address as a normal mailbox', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const mailbox = `${'b'.repeat(32)}@example.test`
    const input = createForwardableMessage(raw, { to: mailbox })

    const result = await captureInboundEmail(
      input.message,
      runtime.env,
      createDependencies(store),
      'trace_catch_all_opaque_0001',
    )

    expect(result.kind).toBe('captured')
    expect(input.rejected).toEqual([])
    expect(runtime.sent[0]).toMatchObject({
      from: expect.objectContaining({ email: mailbox }),
      to: 'owner@example.test',
    })
  })

  it('does not resolve an alias token on a domain where it was not issued', async () => {
    const store = new FakeMailStore()
    seedReplyAlias(store)
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const mailbox = `${ALIAS_TOKEN}@other.example.test`
    const input = createForwardableMessage(raw, {
      from: 'owner@example.test',
      to: mailbox,
    })

    const result = await captureInboundEmail(
      input.message,
      runtime.env,
      createDependencies(store, { generateAliasToken: () => 'c'.repeat(32) }),
      'trace_alias_other_domain_0001',
    )

    expect(result.kind).toBe('captured')
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatchObject({
      from: expect.objectContaining({ email: mailbox }),
      to: 'owner@example.test',
    })
  })

  it('deduplicates logical delivery without forwarding twice', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const dependencies = createDependencies(store)

    await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_duplicate_001',
    )
    const duplicate = await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_duplicate_002',
    )

    expect(duplicate.kind).toBe('duplicate')
    expect(store.projects).toHaveLength(1)
    expect(runtime.sent).toHaveLength(1)
  })

  it('resumes the only still-unclaimed pending forward after a projection-before-claim crash', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const dependencies = createDependencies(store)
    const originalClaim = store.claimPendingForward.bind(store)
    let crashBeforeClaim = true
    store.claimPendingForward = async (input) => {
      if (crashBeforeClaim) {
        crashBeforeClaim = false
        throw new Error('synthetic crash before forward claim')
      }
      return originalClaim(input)
    }

    await expect(
      captureInboundEmail(
        createForwardableMessage(raw).message,
        runtime.env,
        dependencies,
        'trace_forward_preclaim_crash_1',
      ),
    ).rejects.toThrow('synthetic crash before forward claim')
    expect(store.projects[0]?.message).toMatchObject({
      forwardAttemptedAt: null,
      forwardState: 'pending',
    })
    expect(runtime.sent).toEqual([])

    const replay = await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_forward_preclaim_crash_2',
    )
    expect(replay.kind).toBe('duplicate')
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0]?.message.forwardState).toBe('forwarded')
  })

  it('keeps a provider-accepted forward unknown and never blindly resends after result persistence crashes', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const dependencies = createDependencies(store)
    const originalUpdate = store.updateForwardResult.bind(store)
    store.updateForwardResult = async () => {
      throw new Error('synthetic crash after provider acceptance')
    }

    await expect(
      captureInboundEmail(
        createForwardableMessage(raw).message,
        runtime.env,
        dependencies,
        'trace_forward_postprovider_crash_1',
      ),
    ).rejects.toThrow('synthetic crash after provider acceptance')
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects[0]?.message).toMatchObject({
      forwardState: 'unknown',
      providerErrorCode: 'owner_forward_claimed',
    })

    store.updateForwardResult = originalUpdate
    const replay = await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_forward_postprovider_crash_2',
    )
    expect(replay.kind).toBe('duplicate')
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects[0]?.message.forwardState).toBe('unknown')
  })

  it('creates distinct idempotent reply aliases for later messages and changed senders in one thread', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const tokens = ['a'.repeat(32), 'b'.repeat(32)]
    let tokenIndex = 0
    const dependencies = createDependencies(store, {
      generateAliasToken: () => tokens[tokenIndex++] ?? 'c'.repeat(32),
    })
    const firstRaw = encode(inboundFixture)

    await captureInboundEmail(
      createForwardableMessage(firstRaw).message,
      runtime.env,
      dependencies,
      'trace_alias_per_message_1',
    )
    const threadId = store.projects[0]?.message.threadId
    expect(threadId).toBeDefined()
    store.findThreadByMessageIds = async () => threadId
    const secondRaw = encode(
      inboundFixture
        .replace('Alice Example <alice@sender.example.test>', 'Carol Example <carol@example.test>')
        .replace(
          'Alice Replies <alice-replies@sender.example.test>',
          'Carol Replies <carol-replies@example.test>',
        )
        .replace('<synthetic-inbound-1@sender.example.test>', '<synthetic-inbound-2@example.test>'),
    )

    await captureInboundEmail(
      createForwardableMessage(secondRaw, { from: 'carol@example.test' }).message,
      runtime.env,
      dependencies,
      'trace_alias_per_message_2',
    )
    const secondReplay = await captureInboundEmail(
      createForwardableMessage(secondRaw, { from: 'carol@example.test' }).message,
      runtime.env,
      dependencies,
      'trace_alias_per_message_3',
    )

    const aliases = [...store.aliases.values()]
    expect(secondReplay.kind).toBe('duplicate')
    expect(aliases).toHaveLength(2)
    expect(new Set(aliases.map(({ localPart }) => localPart))).toEqual(new Set(tokens))
    expect(aliases.map(({ relayDestination }) => relayDestination).sort()).toEqual([
      'alice-replies@sender.example.test',
      'carol-replies@example.test',
    ])
    expect(new Set(aliases.map(({ targetMessageId }) => targetMessageId))).toEqual(
      new Set(store.projects.map(({ message }) => message.id)),
    )
  })

  it('retains malformed MIME as a diagnosable failed projection', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    const runtime = createFakeEnvironment({ events })
    const raw = encode(malformedFixture)
    const dependencies = createDependencies(store, {
      parseMime: async () => {
        throw new Error('synthetic parser failure')
      },
    })

    await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_malformed_01',
    )

    expect(runtime.objects.size).toBe(1)
    expect(store.projects[0]?.message).toMatchObject({
      forwardState: 'failed',
      providerErrorCode: 'mime_parse_failed',
      subject: 'No subject',
    })
    expect(runtime.sent).toEqual([])
  })

  it('bounds hostile MIME projection fields to the readable thread DTO limits', async () => {
    const recipients = Array.from({ length: 225 }, (_, index) => `recipient-${index}@example.test`)
    const references = Array.from(
      { length: 120 },
      (_, index) => `<reference-${index}@example.test>`,
    )
    const raw = encode(
      [
        'From: sender@example.test',
        `To: ${recipients.join(', ')}`,
        `References: ${references.join(' ')}`,
        'Subject: Bounded hostile fixture',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Readable prefix ${'<>&'.repeat(400_000)}`,
      ].join('\r\n'),
    )

    const parsed = await parseInboundMime(raw, NOW)

    expect(parsed.text.startsWith('Readable prefix')).toBe(true)
    expect(parsed.text.length).toBeLessThanOrEqual(1_000_000)
    expect(parsed.html.length).toBeLessThanOrEqual(2_000_000)
    expect(parsed.to.length + parsed.cc.length + parsed.bcc.length + parsed.replyTo.length).toBe(
      200,
    )
    expect(parsed.references).toHaveLength(100)
    expect(parsed.attachments.length).toBeLessThanOrEqual(100)
  })

  it('removes unprojected raw and never forwards when projection fails', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    store.failProjection = true
    const runtime = createFakeEnvironment({ events })
    const raw = encode(inboundFixture)

    await expect(
      captureInboundEmail(
        createForwardableMessage(raw).message,
        runtime.env,
        createDependencies(store),
        'trace_db_failure_1',
      ),
    ).rejects.toThrow('synthetic projection failure')

    expect(runtime.objects.size).toBe(0)
    expect(runtime.sent).toEqual([])
    expect(store.threads.size).toBe(0)
    expect(events).toContain('r2:delete')
    expect(events.indexOf('r2:put')).toBeLessThan(events.indexOf('db:project-inbound'))
  })

  it('rolls back optional thread creation when inbound workflow projection faults', async () => {
    const store = new FakeMailStore()
    store.failWorkflow = true
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)

    await expect(
      captureInboundEmail(
        createForwardableMessage(raw).message,
        runtime.env,
        createDependencies(store),
        'trace_inbound_atomic_workflow_fault',
      ),
    ).rejects.toThrow('synthetic workflow failure')

    expect(store.threads.size).toBe(0)
    expect(store.projects).toEqual([])
    expect(runtime.sent).toEqual([])
    expect(runtime.objects.size).toBe(0)
  })

  it('performs no D1 or provider side effect when the raw R2 write fails', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment({ failR2: true })
    const raw = encode(inboundFixture)

    await expect(
      captureInboundEmail(
        createForwardableMessage(raw).message,
        runtime.env,
        createDependencies(store),
        'trace_r2_failure_1',
      ),
    ).rejects.toThrow('synthetic R2 failure')
    expect(store.projects).toEqual([])
    expect(runtime.sent).toEqual([])
  })

  it('rejects malformed and oversize envelopes before buffering', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(inboundFixture)
    const dependencies = createDependencies(store)
    const malformed = createForwardableMessage(raw, { to: 'not-an-address' })
    const oversize = createForwardableMessage(raw, { rawSize: 25 * 1_024 * 1_024 + 1 })

    expect(
      await captureInboundEmail(malformed.message, runtime.env, dependencies, 'trace_invalid_0001'),
    ).toEqual({ kind: 'rejected', reason: 'invalid_envelope' })
    expect(
      await captureInboundEmail(oversize.message, runtime.env, dependencies, 'trace_oversize_001'),
    ).toEqual({ kind: 'rejected', reason: 'oversized' })
    expect(malformed.rejected).toHaveLength(1)
    expect(oversize.rejected).toHaveLength(1)
    expect(runtime.objects.size).toBe(0)
  })
})

describe('reply-alias relay', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('relays a direct alias only for the owner and preserves threading', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    seedReplyAlias(store)
    const runtime = createFakeEnvironment({ events })
    const raw = encode(aliasFixture)
    const input = createForwardableMessage(raw, {
      from: 'owner@example.test',
      to: `${ALIAS_TOKEN}@example.test`,
    })

    const result = await captureInboundEmail(
      input.message,
      runtime.env,
      createDependencies(store),
      'trace_alias_relay1',
    )

    expect(result.kind).toBe('relayed')
    expect(runtime.sent).toHaveLength(1)
    expect(runtime.sent[0]).toMatchObject({
      from: { email: 'support@example.test', name: 'Example Support' },
      replyTo: 'support@example.test',
      to: ['alice-replies@sender.example.test'],
    })
    expect(runtime.sent[0]?.headers).toMatchObject({
      'In-Reply-To': '<synthetic-inbound-1@sender.example.test>',
      References: expect.stringContaining('<synthetic-inbound-1@sender.example.test>'),
    })
    expect(store.projects.at(-1)?.message).toMatchObject({
      direction: 'outbound',
      rawSize: raw.byteLength,
      sendState: 'sent',
      threadId: THREAD_ID,
    })
    expect(events.indexOf('r2:put')).toBeLessThan(events.indexOf('email:send'))
    expect(events.indexOf('email:send')).toBeLessThan(events.indexOf('db:complete-outbound'))

    const duplicate = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      createDependencies(store),
      'trace_alias_relay2',
    )
    expect(duplicate.kind).toBe('duplicate')
    expect(runtime.sent).toHaveLength(1)
  })

  it('relays an alias previously issued in plus-addressed form', async () => {
    const store = new FakeMailStore()
    seedReplyAlias(store)
    const runtime = createFakeEnvironment()
    const raw = encode(aliasFixture)

    const result = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `reply+${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      createDependencies(store),
      'trace_alias_plus_compatibility',
    )

    expect(result.kind).toBe('relayed')
    expect(runtime.sent[0]).toMatchObject({
      from: { email: 'support@example.test', name: 'Example Support' },
      replyTo: 'support@example.test',
      to: ['alice-replies@sender.example.test'],
    })
    expect(store.projects.at(-1)?.message.threadId).toBe(THREAD_ID)
  })

  it('rejects a non-owner sender using a known alias before any raw write', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const raw = encode(aliasFixture)
    store.aliases.set(ALIAS_TOKEN, {
      localPart: ALIAS_TOKEN,
      mailboxId: MAILBOX_ID,
      ownerUserId: OWNER_USER_ID,
      relayDestination: 'alice@sender.example.test',
      targetMessageId: INBOUND_MESSAGE_ID,
      threadId: THREAD_ID,
    })
    const attacker = createForwardableMessage(raw, {
      from: 'attacker@outside.example.test',
      to: `${ALIAS_TOKEN}@example.test`,
    })
    expect(
      await captureInboundEmail(
        attacker.message,
        runtime.env,
        createDependencies(store),
        'trace_bad_alias_sender',
      ),
    ).toEqual({ kind: 'rejected', reason: 'unauthorized_alias' })
    expect(runtime.objects.size).toBe(0)
    expect(store.projects).toEqual([])
    expect(runtime.sent).toEqual([])
  })

  it('records a definite relay limit failure without projecting or changing thread state', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    seedReplyAlias(store)
    const runtime = createFakeEnvironment({ events })
    const raw = encode(aliasFixture)
    const dependencies = createDependencies(store, {
      parseMime: async (bytes, receivedAt) => ({
        ...(await parseInboundMime(bytes, receivedAt)),
        attachments: [
          {
            bytes: new Uint8Array(4 * 1_024 * 1_024),
            contentId: null,
            disposition: 'attachment',
            filename: 'large.bin',
            mediaType: 'application/octet-stream',
          },
        ],
      }),
    })

    const result = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_limit_1',
    )

    expect(result.kind).toBe('relay_failed')
    expect(runtime.objects.size).toBe(0)
    expect(runtime.sent).toEqual([])
    expect(store.projects).toEqual([])
    expect(events).not.toContain('db:outbound-workflow')
    expect([...store.sends.values()][0]).toMatchObject({
      messageId: null,
      providerErrorCode: 'provider_message_size_limit',
      state: 'failed',
    })
  })

  it('models provider uncertainty once and projects an explicit unknown relay', async () => {
    const store = new FakeMailStore()
    seedReplyAlias(store)
    const runtime = createFakeEnvironment({ failEmail: true })
    const raw = encode(aliasFixture)
    const dependencies = createDependencies(store)

    const result = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_unknown1',
    )
    const replay = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_unknown2',
    )

    expect(result.kind).toBe('relay_unknown')
    expect(replay.kind).toBe('duplicate')
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0]?.message.sendState).toBe('unknown')
    expect([...store.sends.values()][0]?.state).toBe('unknown')
  })

  it('uses the persisted send id when a queued reply-alias reservation is replayed', async () => {
    const store = new FakeMailStore()
    seedReplyAlias(store)
    const raw = encode(aliasFixture)
    await seedQueuedRelay(store, raw)
    const originalClaim = store.claimQueuedSend.bind(store)
    const claim = vi.fn(async (input: Parameters<typeof originalClaim>[0]) => originalClaim(input))
    store.claimQueuedSend = claim
    const runtime = createFakeEnvironment()

    const result = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      createDependencies(store),
      'trace_alias_queued_replay',
    )

    expect(result.kind).toBe('relayed')
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ id: SEND_ID }))
    expect([...store.sends.values()][0]).toMatchObject({ id: SEND_ID, state: 'sent' })
  })

  it('classifies a concurrent claim loser as unknown without a second provider call', async () => {
    const store = new FakeMailStore()
    seedReplyAlias(store)
    const runtime = createFakeEnvironment()
    let providerCalls = 0
    let releaseProvider!: () => void
    let providerEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      providerEntered = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseProvider = resolve
    })
    runtime.env.EMAIL = {
      async send() {
        providerCalls += 1
        providerEntered()
        await release
        return { messageId: '<provider-accepted@example.test>' }
      },
    } as SendEmail
    const raw = encode(aliasFixture)
    const dependencies = createDependencies(store)
    const first = captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_concurrent_1',
    )
    await entered

    const loser = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_concurrent_2',
    )
    expect(loser).toMatchObject({ kind: 'relay_unknown', sendId: expect.any(String) })
    expect(providerCalls).toBe(1)

    releaseProvider()
    await expect(first).resolves.toMatchObject({ kind: 'relayed' })
    expect(providerCalls).toBe(1)
  })

  it('keeps relay projection, workflow, and send finalization all-or-nothing on a D1 fault', async () => {
    const store = new FakeMailStore()
    store.failWorkflow = true
    seedReplyAlias(store)
    const runtime = createFakeEnvironment()
    const raw = encode(aliasFixture)
    const dependencies = createDependencies(store)

    const first = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_atomic_fault_1',
    )
    const replay = await captureInboundEmail(
      createForwardableMessage(raw, {
        from: 'owner@example.test',
        to: `${ALIAS_TOKEN}@example.test`,
      }).message,
      runtime.env,
      dependencies,
      'trace_alias_atomic_fault_2',
    )

    expect(first.kind).toBe('relay_unknown')
    expect(replay.kind).toBe('relay_unknown')
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects).toEqual([])
    expect([...store.sends.values()][0]).toMatchObject({ messageId: null, state: 'sending' })
  })
})

function seedReplyAlias(store: FakeMailStore): void {
  store.aliases.set(ALIAS_TOKEN, {
    localPart: ALIAS_TOKEN,
    mailboxId: MAILBOX_ID,
    ownerUserId: OWNER_USER_ID,
    relayDestination: 'alice-replies@sender.example.test',
    targetMessageId: INBOUND_MESSAGE_ID,
    threadId: THREAD_ID,
  })
  store.context = {
    mailbox: store.context.mailbox,
    messages: [
      {
        direction: 'inbound',
        fromAddress: 'alice@sender.example.test',
        id: INBOUND_MESSAGE_ID,
        inReplyTo: null,
        internetMessageId: '<synthetic-inbound-1@sender.example.test>',
        providerMessageId: null,
        references: ['<synthetic-root@sender.example.test>'],
        replyTo: ['alice-replies@sender.example.test'],
        sentAt: NOW - 60_000,
      },
    ],
    thread: { archivedAt: null, id: THREAD_ID, subject: 'Synthetic support request' },
  }
}

async function seedQueuedRelay(store: FakeMailStore, raw: Uint8Array): Promise<void> {
  const rawSha256 = await sha256Hex(raw)
  const ingestDigest = await computeInboundIngestDigest({
    envelopeFrom: 'owner@example.test',
    envelopeTo: `${ALIAS_TOKEN}@example.test`,
    rawSha256,
  })
  const requestDigest = await computeIdempotencyRequestDigest({
    ingestDigest,
    kind: 'reply_alias_relay',
    threadId: THREAD_ID,
    version: 1,
  })
  const idempotencyKey = `relay-${ingestDigest}`
  store.sends.set(idempotencyKey, {
    actorUserId: OWNER_USER_ID,
    attemptCount: 0,
    createdAt: NOW,
    id: SEND_ID,
    idempotencyKey,
    lastAttemptedAt: null,
    mailboxId: MAILBOX_ID,
    messageId: null,
    providerErrorCode: null,
    providerMessageId: null,
    requestDigest,
    retryability: 'retryable',
    state: 'queued',
    threadId: THREAD_ID,
    updatedAt: NOW,
  })
}
