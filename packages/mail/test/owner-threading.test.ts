import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AuthRepository,
  retryabilityForMessageState,
  createInboxDatabase,
  threads,
  messages,
  messageReferences,
} from '@cloudflare-inbox/db'
import { eq } from 'drizzle-orm'
import { captureInboundEmail } from '../src/services/inbound'
import { D1MailStore } from '../src/services/mail-store'
import { TestD1Database } from './support/d1'
import {
  NOW,
  FakeMailStore,
  createDependencies,
  createFakeEnvironment,
  createForwardableMessage,
  testUuid,
} from './support/fakes'

const databases: TestD1Database[] = []
afterEach(() => databases.splice(0).forEach((database) => database.close()))
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

async function setup() {
  const database = new TestD1Database()
  databases.push(database)
  const binding = database.asD1()
  const store = new D1MailStore(binding)
  const runtime = createFakeEnvironment()
  runtime.env.DB = binding
  let id = 100,
    alias = 0,
    tick = 0
  const dependencies = createDependencies(new FakeMailStore(), {
    createStore: () => store,
    generateId: () => testUuid(id++),
    generateAliasToken: () => 'a'.repeat(31) + String.fromCharCode(97 + alias++),
    now: () => NOW + tick++,
  })
  await new AuthRepository(binding).bootstrapOwner({
    mailboxAddress: 'support@example.test',
    mailboxId: testUuid(90),
    now: NOW,
    ownerEmail: 'owner@example.test',
    userId: testUuid(91),
  })
  vi.spyOn(runtime.env.EMAIL, 'send').mockImplementation(async (builder) => {
    runtime.sent.push(builder as EmailMessageBuilder)
    return { messageId: `<delivery-${runtime.sent.length}@example.test>` }
  })
  const receive = async (
    name: string,
    parent: string | null = null,
    references: string[] = [],
    from = 'customer@example.test',
    to = 'support@example.test',
    subject = 'Synthetic thread bridge',
  ) => {
    const raw = new TextEncoder().encode(
      [
        `From: ${from}`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: <${name}@example.test>`,
        `Date: ${new Date(NOW + tick).toUTCString()}`,
        ...(parent ? [`In-Reply-To: ${parent}`] : []),
        ...(references.length ? [`References: ${references.join(' ')}`] : []),
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Synthetic threading regression.',
      ].join('\r\n'),
    )
    return captureInboundEmail(
      createForwardableMessage(raw, { from, to }).message,
      runtime.env,
      dependencies,
      `threading-${name}`,
    )
  }
  return { db: createInboxDatabase(binding), store, runtime, receive }
}

describe('owner-visible reply threading', () => {
  it('bridges two complete owner-reply relay round trips using the actual forwarded IDs', async () => {
    const { db, runtime, receive } = await setup()
    const first = await receive('customer-1')
    expect(first.kind).toBe('captured')
    expect(runtime.sent[0]?.headers).toBeUndefined()
    const firstAlias = runtime.sent[0]?.replyTo
    if (typeof firstAlias !== 'string') throw new Error('Expected reply alias')
    expect(
      await receive(
        'owner-1',
        '<delivery-1@example.test>',
        ['<delivery-1@example.test>'],
        'owner@example.test',
        firstAlias,
        'Re: Synthetic thread bridge',
      ),
    ).toMatchObject({ kind: 'relayed' })
    expect(runtime.sent[1]?.headers).toEqual({
      'In-Reply-To': '<customer-1@example.test>',
      References: '<customer-1@example.test>',
    })
    await receive('customer-2', '<delivery-2@example.test>', [
      '<customer-1@example.test>',
      '<delivery-2@example.test>',
    ])
    expect(runtime.sent[2]?.headers).toEqual({
      'In-Reply-To': '<delivery-2@example.test>',
      References: '<customer-1@example.test> <delivery-1@example.test> <delivery-2@example.test>',
    })
    // Gmail's sent message and the customer's delivered copy have different IDs.
    // The next forward still connects to the owner's previously received copy.
    const secondAlias = runtime.sent[2]?.replyTo
    if (typeof secondAlias !== 'string') throw new Error('Expected reply alias')
    await receive(
      'owner-2',
      '<delivery-3@example.test>',
      ['<delivery-3@example.test>'],
      'owner@example.test',
      secondAlias,
      'Re: Synthetic thread bridge',
    )
    const customerReferences = [
      '<customer-1@example.test>',
      '<delivery-2@example.test>',
      '<customer-2@example.test>',
      '<delivery-4@example.test>',
    ]
    await receive('customer-3', '<delivery-4@example.test>', customerReferences)
    expect(runtime.sent[4]?.headers).toEqual({
      'In-Reply-To': '<delivery-4@example.test>',
      References:
        '<customer-1@example.test> <delivery-2@example.test> <customer-2@example.test> <delivery-3@example.test> <delivery-4@example.test>',
    })
    expect(await db.select({ messageCount: threads.messageCount }).from(threads)).toEqual([
      { messageCount: 5 },
    ])
    // Bridge IDs belong only to the forwarded copy; original stored headers stay intact.
    const storedReferences = await db
      .select({ id: messageReferences.internetMessageId })
      .from(messageReferences)
      .innerJoin(messages, eq(messageReferences.messageId, messages.id))
      .where(eq(messages.internetMessageId, '<customer-3@example.test>'))
      .orderBy(messageReferences.position)
    expect(storedReferences.map((row) => row.id)).toEqual(customerReferences)
    await receive('customer-3', '<delivery-4@example.test>', customerReferences)
    expect(runtime.sent).toHaveLength(5)
  })

  it('scopes the bridge to the mailbox and thread and excludes unconfirmed forwards', async () => {
    const { db, store, runtime, receive } = await setup()
    const first = await receive('first')
    if (first.kind !== 'captured') throw new Error('Expected a captured message')
    expect(await store.findLatestOwnerForward(testUuid(90), first.threadId)).toBe(
      '<delivery-1@example.test>',
    )
    expect(await store.findLatestOwnerForward(testUuid(999), first.threadId)).toBeNull()
    expect(await store.findLatestOwnerForward(testUuid(90), testUuid(998))).toBeNull()
    await receive(
      'unrelated',
      null,
      [],
      'customer@example.test',
      'support@example.test',
      'Unrelated request',
    )
    expect(runtime.sent[1]?.headers).toBeUndefined()
    expect(await store.findLatestOwnerForward(testUuid(90), first.threadId)).toBe(
      '<delivery-1@example.test>',
    )
    for (const state of ['pending', 'unknown', 'failed', 'not_applicable'] as const) {
      await db
        .update(messages)
        .set({
          forwardState: state,
          providerErrorCode: state === 'unknown' || state === 'failed' ? 'synthetic_failure' : null,
          retryability: retryabilityForMessageState({
            direction: 'inbound',
            forwardState: state,
            sendState: 'not_applicable',
          }),
        })
        .where(eq(messages.id, first.messageId))
      expect(await store.findLatestOwnerForward(testUuid(90), first.threadId)).toBeNull()
    }
  })

  it('retains the bridge under long references and resumes safely if its lookup failed before claiming', async () => {
    const { db, store, runtime, receive } = await setup()
    await receive('root')
    const references = Array.from(
      { length: 40 },
      (_, index) => `<${index}-${'x'.repeat(80)}@example.test>`,
    )
    references.push('<root@example.test>')
    const lookup = vi
      .spyOn(store, 'findLatestOwnerForward')
      .mockRejectedValueOnce(new Error('Synthetic lookup failure'))
    await expect(receive('followup', '<root@example.test>', references)).rejects.toThrow(
      'Synthetic lookup failure',
    )
    expect(runtime.sent).toHaveLength(1)
    expect(
      await db
        .select({ forwardState: messages.forwardState, attemptedAt: messages.forwardAttemptedAt })
        .from(messages)
        .where(eq(messages.internetMessageId, '<followup@example.test>')),
    ).toEqual([{ forwardState: 'pending', attemptedAt: null }])
    lookup.mockRestore()
    await receive('followup', '<root@example.test>', references)
    const headers = runtime.sent[1]?.headers as Record<string, string>
    expect(headers['In-Reply-To']).toBe('<root@example.test>')
    expect(headers['References']).toContain('<delivery-1@example.test>')
    expect(headers['References']).toMatch(/<root@example.test>$/u)
    expect(new TextEncoder().encode(headers['References']).byteLength).toBeLessThanOrEqual(2048)
    expect(runtime.sent).toHaveLength(2)
  })
})
