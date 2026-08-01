import {
  InternalSendRequestSchema,
  SendCommandSchema,
  type InternalSendRequest,
} from '@cloudflare-inbox/contracts'
import {
  canonicalEmlToText,
  computeIdempotencyRequestDigest,
  sha256Hex,
} from '@cloudflare-inbox/mail-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MailFault } from '../src/errors'
import { parseInternalSendRequest, submitInternalSend } from '../src/services/outbound'
import type { PreparedInternalSend } from '../src/types'
import {
  INBOUND_MESSAGE_ID,
  MAILBOX_ID,
  NOW,
  OWNER_USER_ID,
  SEND_ID,
  THREAD_ID,
  FakeMailStore,
  createDependencies,
  createFakeEnvironment,
} from './support/fakes'

describe('internal outbound submission', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  it('reserves before sending, stores canonical EML before projection, and replays once', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    const runtime = createFakeEnvironment({ events })
    const prepared = await newMessage({
      bcc: [{ address: 'auditor@example.test' }],
      cc: [{ address: 'copy@example.test', displayName: 'Copy' }],
    })
    const dependencies = createDependencies(store)

    const first = await submitInternalSend(prepared, runtime.env, dependencies)
    const second = await submitInternalSend(prepared, runtime.env, dependencies)

    expect(first.status).toBe(201)
    expect(first.response).toMatchObject({
      messageId: expect.stringMatching(/-7[0-9a-f]{3}-/u),
      safeErrorCode: null,
      state: 'sent',
    })
    expect(second.response).toEqual(first.response)
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects).toHaveLength(1)
    expect(events.indexOf('db:reserve-send')).toBeLessThan(events.indexOf('email:send'))
    expect(events.indexOf('email:send')).toBeLessThan(events.indexOf('r2:put'))
    expect(events.indexOf('r2:put')).toBeLessThan(events.indexOf('db:complete-outbound'))
    const raw = [...runtime.objects.values()][0]
    expect(raw).toBeDefined()
    const eml = canonicalEmlToText(raw ?? new Uint8Array())
    expect(eml).toContain('Cc: "Copy" <copy@example.test>')
    expect(eml).not.toContain('auditor@example.test')
    const structured = vi
      .mocked(console.info)
      .mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    expect(structured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: 'test',
          event: 'mail.outbound.started',
          outcome: 'started',
        }),
        expect.objectContaining({
          event: 'mail.outbound.completed',
          outcome: 'completed',
          state: 'sent',
        }),
      ]),
    )
    const serialized = JSON.stringify(structured)
    expect(serialized).not.toContain('recipient@receiver.example.test')
    expect(serialized).not.toContain('raw/outbound/')
    expect(serialized).not.toContain('Synthetic outbound subject')
    expect(serialized).not.toContain('A synthetic outbound body')
  })

  it('rejects a conflicting reuse without a second provider call', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const dependencies = createDependencies(store)
    const first = await newMessage()
    await submitInternalSend(first, runtime.env, dependencies)
    const conflicting = await newMessage({ subject: 'Different synthetic subject' })

    await expect(submitInternalSend(conflicting, runtime.env, dependencies)).rejects.toMatchObject({
      code: 'idempotency_conflict',
      status: 409,
    })
    expect(runtime.sent).toHaveLength(1)
  })

  it('records provider exceptions as unknown and never retries implicitly', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment({ failEmail: true })
    const prepared = await newMessage()
    const dependencies = createDependencies(store)

    const first = await submitInternalSend(prepared, runtime.env, dependencies)
    const replay = await submitInternalSend(prepared, runtime.env, dependencies)

    expect(first).toMatchObject({ status: 202, response: { state: 'unknown' } })
    expect(replay.response).toEqual(first.response)
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects[0]?.message.sendState).toBe('unknown')
  })

  it('leaves a single claimed send without contradictory projection when atomic completion faults', async () => {
    const store = new FakeMailStore()
    store.failWorkflow = true
    const runtime = createFakeEnvironment()
    const prepared = await newMessage()
    const dependencies = createDependencies(store)

    const first = await submitInternalSend(prepared, runtime.env, dependencies)
    const replay = await submitInternalSend(prepared, runtime.env, dependencies)

    expect(first).toMatchObject({
      status: 202,
      response: { messageId: null, retryability: 'manual_confirmation_required', state: 'sending' },
    })
    expect(replay.response).toEqual(first.response)
    expect(runtime.sent).toHaveLength(1)
    expect(store.projects).toEqual([])
    expect([...store.sends.values()][0]).toMatchObject({ messageId: null, state: 'sending' })
  })

  it('resumes a queued replay only after winning the atomic delivery claim', async () => {
    const store = new FakeMailStore()
    const prepared = await newMessage()
    store.sends.set(prepared.request.idempotencyKey, {
      actorUserId: OWNER_USER_ID,
      attemptCount: 0,
      createdAt: NOW,
      id: SEND_ID,
      idempotencyKey: prepared.request.idempotencyKey,
      lastAttemptedAt: null,
      mailboxId: MAILBOX_ID,
      messageId: null,
      providerErrorCode: null,
      providerMessageId: null,
      requestDigest: prepared.request.requestDigest,
      retryability: 'retryable',
      state: 'queued',
      threadId: THREAD_ID,
      updatedAt: NOW,
    })
    const runtime = createFakeEnvironment()

    const result = await submitInternalSend(prepared, runtime.env, createDependencies(store))

    expect(result.response.state).toBe('sent')
    expect(runtime.sent).toHaveLength(1)
    expect(store.events).toContain('db:claim-send')
  })

  it('returns current queued status without sending when another claimant wins', async () => {
    const store = new FakeMailStore()
    store.claimQueuedSend = async () => false
    const runtime = createFakeEnvironment()

    const result = await submitInternalSend(
      await newMessage(),
      runtime.env,
      createDependencies(store),
    )

    expect(result).toMatchObject({
      status: 202,
      response: { retryability: 'retryable', state: 'queued' },
    })
    expect(runtime.sent).toEqual([])
    expect(store.projects).toEqual([])
  })

  it('does not strand a new thread when the atomic reservation faults', async () => {
    const store = new FakeMailStore()
    store.failReservation = true
    const runtime = createFakeEnvironment()

    await expect(
      submitInternalSend(await newMessage(), runtime.env, createDependencies(store)),
    ).rejects.toThrow('synthetic reservation failure')

    expect(store.threads.size).toBe(0)
    expect(store.sends.size).toBe(0)
    expect(store.projects).toEqual([])
    expect(runtime.sent).toEqual([])
  })

  it('marks the send unknown when canonical R2 persistence fails after acceptance', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment({ failR2: true })
    const result = await submitInternalSend(
      await newMessage(),
      runtime.env,
      createDependencies(store),
    )

    expect(runtime.sent).toHaveLength(1)
    expect(result).toMatchObject({
      status: 202,
      response: { messageId: null, state: 'unknown' },
    })
    expect(store.projects).toEqual([])
  })

  it('fails provider-limit validation without canonical raw, projection, or workflow changes', async () => {
    const events: string[] = []
    const store = new FakeMailStore(events)
    const runtime = createFakeEnvironment({ events })
    // This remains inside the public 10 MiB/file and 20 MiB/request contract,
    // but base64/MIME overhead exceeds the general 5 MiB provider profile.
    const attachment = new File([new Uint8Array(4 * 1_024 * 1_024)], 'large.bin', {
      type: 'application/octet-stream',
    })

    await expect(
      submitInternalSend(
        await newMessage({ attachments: [attachment] }),
        runtime.env,
        createDependencies(store),
      ),
    ).rejects.toMatchObject({ code: 'request_too_large', status: 413 })

    expect(runtime.sent).toEqual([])
    expect(runtime.objects.size).toBe(0)
    expect(store.projects).toEqual([])
    expect(store.sends.size).toBe(0)
    expect(store.threads.size).toBe(0)
    expect(events).not.toContain('db:outbound-workflow')
  })

  it('uses a selected inbound target and preserves bounded thread headers on replies', async () => {
    const store = new FakeMailStore()
    store.context = {
      mailbox: store.context.mailbox,
      messages: [
        {
          direction: 'inbound',
          fromAddress: 'alice@sender.example.test',
          id: INBOUND_MESSAGE_ID,
          inReplyTo: null,
          internetMessageId: '<target@sender.example.test>',
          providerMessageId: null,
          references: ['<root@sender.example.test>'],
          replyTo: ['alice-replies@sender.example.test'],
          sentAt: NOW - 1_000,
        },
      ],
      thread: { archivedAt: null, id: THREAD_ID, subject: 'Synthetic support request' },
    }
    const runtime = createFakeEnvironment()
    const prepared = await replyMessage()

    const result = await submitInternalSend(prepared, runtime.env, createDependencies(store))

    expect(result.status).toBe(201)
    expect(runtime.sent[0]).toMatchObject({
      headers: {
        'In-Reply-To': '<target@sender.example.test>',
        References: '<root@sender.example.test> <target@sender.example.test>',
      },
      subject: 'Re: Synthetic support request',
    })
    expect(store.projects[0]?.references.map(({ internetMessageId }) => internetMessageId)).toEqual(
      ['<root@sender.example.test>', '<target@sender.example.test>'],
    )
  })

  it('validates attachment descriptors and the API request/contract metadata field aliases', async () => {
    const file = new File(['synthetic attachment'], 'evidence.txt', { type: 'text/plain' })
    const prepared = await newMessage({ attachments: [file] })
    for (const fieldName of ['request', 'metadata'] as const) {
      const form = new FormData()
      form.set(fieldName, JSON.stringify(prepared.request))
      form.append('attachments', file, file.name)
      await expect(parseInternalSendRequest(form)).resolves.toMatchObject({
        attachments: [expect.objectContaining({ name: 'evidence.txt' })],
      })
    }

    const mismatch = new FormData()
    mismatch.set('metadata', JSON.stringify(prepared.request))
    mismatch.append(
      'attachments',
      new File(['wrong'], 'wrong.txt', { type: 'text/plain' }),
      'wrong.txt',
    )
    await expect(parseInternalSendRequest(mismatch)).rejects.toBeInstanceOf(MailFault)
  })

  it('rejects a tampered request digest before reserving', async () => {
    const store = new FakeMailStore()
    const runtime = createFakeEnvironment()
    const prepared = await newMessage()
    prepared.request = InternalSendRequestSchema.parse({
      ...prepared.request,
      requestDigest: '0'.repeat(64),
    })

    await expect(
      submitInternalSend(prepared, runtime.env, createDependencies(store)),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 })
    expect(store.sends.size).toBe(0)
    expect(runtime.sent).toEqual([])
  })
})

type NewMessageOptions = {
  attachments?: File[]
  bcc?: Array<{ address: string; displayName?: string }>
  cc?: Array<{ address: string; displayName?: string }>
  subject?: string
  to?: Array<{ address: string; displayName?: string }>
}

async function newMessage(options: NewMessageOptions = {}): Promise<PreparedInternalSend> {
  const attachments = options.attachments ?? []
  const command = {
    message: {
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((file) => ({
              filename: file.name,
              mediaType: file.type,
              size: file.size,
            })),
          }),
      ...(options.bcc === undefined ? {} : { bcc: options.bcc }),
      body: 'A synthetic outbound body.',
      ...(options.cc === undefined ? {} : { cc: options.cc }),
      format: 'markdown' as const,
      mailboxId: MAILBOX_ID,
      subject: options.subject ?? 'Synthetic outbound subject',
      to: options.to ?? [{ address: 'recipient@receiver.example.test', displayName: 'Recipient' }],
    },
    mode: 'new' as const,
  }
  return preparedRequest(command, attachments)
}

async function replyMessage(): Promise<PreparedInternalSend> {
  const command = {
    message: {
      body: 'A synthetic threaded reply.',
      format: 'plain' as const,
      mailboxId: MAILBOX_ID,
      subject: 'Re: Synthetic support request',
      targetMessageId: INBOUND_MESSAGE_ID,
      threadId: THREAD_ID,
      to: [{ address: 'alice-replies@sender.example.test' }],
    },
    mode: 'reply' as const,
  }
  return preparedRequest(command, [])
}

async function preparedRequest(
  commandInput: unknown,
  attachments: File[],
): Promise<PreparedInternalSend> {
  const command = SendCommandSchema.parse(commandInput) as InternalSendRequest['command']
  const attachmentDigests = await Promise.all(
    attachments.map(async (attachment) => ({
      filename: attachment.name,
      mediaType: attachment.type,
      sha256: await sha256Hex(await attachment.arrayBuffer()),
      size: attachment.size,
    })),
  )
  const requestDigest = await computeIdempotencyRequestDigest({
    attachments: attachmentDigests,
    command,
    version: 1,
  })
  return {
    attachments,
    request: InternalSendRequestSchema.parse({
      actor: {
        authKind: 'session',
        mailboxId: MAILBOX_ID,
        scopes: ['read', 'send', 'settings'],
        userId: OWNER_USER_ID,
      },
      command,
      idempotencyKey: 'synthetic-send-key-0001',
      requestDigest,
      requestId: 'trace_outbound_0001',
    }),
  }
}
