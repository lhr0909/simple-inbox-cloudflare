/// <reference types="node" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

import {
  createInboxDatabase,
  MailboxScopedRepository,
  mailboxes,
  messages,
  replyAliases,
  threads,
} from '@cloudflare-inbox/db'

import { captureInboundEmail } from '../src/services/inbound'
import { D1MailStore } from '../src/services/mail-store'
import inboundFixture from './fixtures/inbound-with-attachment.eml?raw'
import { TestD1Database } from './support/d1'
import {
  ALIAS_TOKEN,
  NOW,
  createDependencies,
  createFakeEnvironment,
  createForwardableMessage,
  testUuid,
  FakeMailStore,
} from './support/fakes'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('mail module D1 adapter', () => {
  it('runs the real inbound projection, alias, aggregate, and forward-state path', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const binding = database.asD1()
    const store = new D1MailStore(binding)
    const runtime = createFakeEnvironment()
    runtime.env.DB = binding
    let id = 100
    const dependencies = createDependencies(new FakeMailStore(), {
      createStore: () => store,
      generateId: () => testUuid(id++),
    })
    const raw = new TextEncoder().encode(inboundFixture)

    const outcome = await captureInboundEmail(
      createForwardableMessage(raw).message,
      runtime.env,
      dependencies,
      'trace_real_d1_0001',
    )

    expect(outcome.kind).toBe('captured')
    const db = createInboxDatabase(binding)
    const [mailbox] = await db
      .select({ address: mailboxes.address, forwardTo: mailboxes.forwardTo, id: mailboxes.id })
      .from(mailboxes)
    const [thread] = await db
      .select({
        lastDirection: threads.lastMessageDirection,
        messageCount: threads.messageCount,
        unreadCount: threads.unreadCount,
        workflowState: threads.workflowState,
      })
      .from(threads)
    const [message] = await db
      .select({
        direction: messages.direction,
        forwardState: messages.forwardState,
        ingestDigest: messages.ingestDigest,
        providerMessageId: messages.providerMessageId,
        rawSize: messages.rawSize,
      })
      .from(messages)
    const [alias] = await db
      .select({
        localPart: replyAliases.localPart,
        relayDestination: replyAliases.relayDestination,
      })
      .from(replyAliases)

    expect(mailbox).toMatchObject({
      address: 'support@example.test',
      forwardTo: 'owner@example.test',
    })
    expect(thread).toEqual({
      lastDirection: 'inbound',
      messageCount: 1,
      unreadCount: 1,
      workflowState: 'needs_reply',
    })
    expect(message).toMatchObject({
      direction: 'inbound',
      forwardState: 'forwarded',
      providerMessageId: '<provider-accepted@example.test>',
      rawSize: raw.byteLength,
    })
    expect(alias).toEqual({
      localPart: ALIAS_TOKEN,
      relayDestination: 'alice-replies@sender.example.test',
    })
    expect(await store.resolveReplyAlias(`${ALIAS_TOKEN}@example.test`)).toMatchObject({
      localPart: ALIAS_TOKEN,
      mailboxId: mailbox?.id,
      threadId: outcome.kind === 'captured' ? outcome.threadId : undefined,
    })
    expect(await store.resolveReplyAlias(`${ALIAS_TOKEN}@other.example.test`)).toBeUndefined()
    expect(message?.ingestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(await store.findInboundByDigest(String(message?.ingestDigest))).toMatchObject({
      messageId: expect.any(String),
      threadId: expect.any(String),
    })
    if (outcome.kind !== 'captured') throw new Error('Synthetic inbound was not captured.')
    const idempotentAlias = await store.ensureReplyAlias({
      aliasId: testUuid(190),
      localPart: 'c'.repeat(32),
      mailboxId: String(mailbox?.id),
      now: NOW + 1,
      relayDestination: 'alice-replies@sender.example.test',
      targetMessageId: outcome.messageId,
      threadId: outcome.threadId,
    })
    expect(idempotentAlias?.localPart).toBe(ALIAS_TOKEN)

    const secondMessageId = testUuid(191)
    await store.projectInboundMessage({
      projection: {
        attachments: [],
        message: {
          createdAt: NOW + 2,
          direction: 'inbound',
          forwardAttemptedAt: null,
          forwardState: 'pending',
          fromAddress: 'carol@example.test',
          fromName: 'Carol Example',
          htmlBody: null,
          htmlPolicy: 'none',
          id: secondMessageId,
          inReplyTo: '<synthetic-inbound-1@sender.example.test>',
          ingestDigest: 'd'.repeat(64),
          internetMessageId: '<synthetic-inbound-2@example.test>',
          mailboxId: String(mailbox?.id),
          preview: 'Second synthetic message',
          providerErrorCode: null,
          providerMessageId: null,
          rawR2Key: 'raw/inbound/2026/08/01/synthetic-second.eml',
          rawSha256: 'e'.repeat(64),
          rawSize: 128,
          readAt: null,
          receivedAt: NOW + 2,
          sendAttemptedAt: null,
          sendState: 'not_applicable',
          sentAt: NOW + 2,
          subject: 'Re: Synthetic support request',
          textBody: 'Second synthetic body',
          threadId: outcome.threadId,
          updatedAt: NOW + 2,
        },
        recipients: [
          {
            address: 'support@example.test',
            displayName: null,
            kind: 'to',
            position: 0,
          },
        ],
        references: [
          { internetMessageId: '<synthetic-inbound-1@sender.example.test>', position: 0 },
        ],
      },
    })
    const secondAlias = await store.ensureReplyAlias({
      aliasId: testUuid(192),
      localPart: 'f'.repeat(32),
      mailboxId: String(mailbox?.id),
      now: NOW + 2,
      relayDestination: 'carol-replies@example.test',
      targetMessageId: secondMessageId,
      threadId: outcome.threadId,
    })
    expect(secondAlias).toMatchObject({
      localPart: 'f'.repeat(32),
      relayDestination: 'carol-replies@example.test',
      targetMessageId: secondMessageId,
    })
    expect(
      await db
        .select({
          localPart: replyAliases.localPart,
          relayDestination: replyAliases.relayDestination,
          targetMessageId: replyAliases.targetMessageId,
        })
        .from(replyAliases),
    ).toEqual(
      expect.arrayContaining([
        {
          localPart: ALIAS_TOKEN,
          relayDestination: 'alice-replies@sender.example.test',
          targetMessageId: outcome.messageId,
        },
        {
          localPart: 'f'.repeat(32),
          relayDestination: 'carol-replies@example.test',
          targetMessageId: secondMessageId,
        },
      ]),
    )
    expect(await store.claimPendingForward({ messageId: secondMessageId, now: NOW + 3 })).toBe(true)
    expect(await store.claimPendingForward({ messageId: secondMessageId, now: NOW + 4 })).toBe(
      false,
    )
    expect(
      await db
        .select({
          forwardState: messages.forwardState,
          providerErrorCode: messages.providerErrorCode,
          retryability: messages.retryability,
        })
        .from(messages)
        .where(eq(messages.id, secondMessageId)),
    ).toEqual([
      {
        forwardState: 'unknown',
        providerErrorCode: 'owner_forward_claimed',
        retryability: 'manual_confirmation_required',
      },
    ])
  })

  it('projects catch-all mailboxes and their thread metadata into D1', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const binding = database.asD1()
    const store = new D1MailStore(binding)
    const runtime = createFakeEnvironment()
    runtime.env.DB = binding
    let id = 200
    const dependencies = createDependencies(new FakeMailStore(), {
      createStore: () => store,
      generateId: () => testUuid(id++),
    })
    const raw = new TextEncoder().encode(inboundFixture)

    const outcome = await captureInboundEmail(
      createForwardableMessage(raw, { to: 'campaigns@other.example.test' }).message,
      runtime.env,
      dependencies,
      'trace_real_d1_catch_all_0001',
    )

    expect(outcome.kind).toBe('captured')
    const db = createInboxDatabase(binding)
    const [mailbox] = await db
      .select({ address: mailboxes.address, forwardTo: mailboxes.forwardTo, id: mailboxes.id })
      .from(mailboxes)
      .where(eq(mailboxes.address, 'campaigns@other.example.test'))
    const [thread] = await db
      .select({ mailboxId: threads.mailboxId, messageCount: threads.messageCount })
      .from(threads)
      .where(eq(threads.mailboxId, String(mailbox?.id)))
    const [message] = await db
      .select({ mailboxId: messages.mailboxId, rawR2Key: messages.rawR2Key })
      .from(messages)
      .where(eq(messages.mailboxId, String(mailbox?.id)))

    expect(mailbox).toMatchObject({
      address: 'campaigns@other.example.test',
      forwardTo: 'owner@example.test',
    })
    expect(thread).toEqual({ mailboxId: mailbox?.id, messageCount: 1 })
    expect(message).toMatchObject({ mailboxId: mailbox?.id, rawR2Key: expect.any(String) })
    expect(runtime.objects.get(String(message?.rawR2Key))).toEqual(raw)
  })

  it('enforces actor mailbox scope for outbound context and send reservation', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const store = new D1MailStore(database.asD1())
    const mailbox = await store.ensureMailbox({
      mailboxAddress: 'support@example.test',
      mailboxId: testUuid(201),
      now: NOW,
      ownerEmail: 'owner@example.test',
      userId: testUuid(200),
    })
    const context = await store.getOutboundContext({
      actorUserId: mailbox.ownerUserId,
      mailboxId: mailbox.id,
    })
    const unauthorized = await store.getOutboundContext({
      actorUserId: testUuid(999),
      mailboxId: mailbox.id,
    })
    const reserved = await store.reserveOutboundSend({
      actorUserId: mailbox.ownerUserId,
      createdAt: NOW,
      id: testUuid(202),
      idempotencyKey: 'synthetic-store-send-0001',
      mailboxId: mailbox.id,
      requestDigest: 'a'.repeat(64),
      threadId: null,
    })
    const denied = await store.reserveOutboundSend({
      actorUserId: testUuid(999),
      createdAt: NOW,
      id: testUuid(203),
      idempotencyKey: 'synthetic-store-send-0002',
      mailboxId: mailbox.id,
      requestDigest: 'b'.repeat(64),
      threadId: null,
    })

    expect(context?.mailbox).toMatchObject({ id: mailbox.id, ownerUserId: mailbox.ownerUserId })
    expect(unauthorized).toBeUndefined()
    expect(reserved.kind).toBe('reserved')
    expect(denied.kind).toBe('conflict')
  })

  it('preserves disabled forwarding across inbound bootstrap and captures without sending', async () => {
    const database = new TestD1Database()
    databases.push(database)
    const binding = database.asD1()
    const store = new D1MailStore(binding)
    const mailbox = await store.ensureMailbox({
      mailboxAddress: 'disabled-forward@example.test',
      mailboxId: testUuid(301),
      now: NOW,
      ownerEmail: 'owner@example.test',
      userId: testUuid(300),
    })
    const settings = new MailboxScopedRepository(binding, { userId: mailbox.ownerUserId })
    expect(await settings.updateMailboxSettings(mailbox.id, { forwardTo: null }, NOW + 1)).toBe(
      true,
    )

    const runtime = createFakeEnvironment()
    runtime.env.DB = binding
    let id = 310
    const dependencies = createDependencies(new FakeMailStore(), {
      createStore: () => store,
      generateId: () => testUuid(id++),
      now: () => NOW + 2,
    })
    const raw = new TextEncoder().encode(inboundFixture)
    const result = await captureInboundEmail(
      createForwardableMessage(raw, { to: 'disabled-forward@example.test' }).message,
      runtime.env,
      dependencies,
      'trace_disabled_forward_real_d1',
    )

    const db = createInboxDatabase(binding)
    const [storedMailbox] = await db
      .select({ forwardTo: mailboxes.forwardTo })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailbox.id))
    const [projected] = await db
      .select({
        forwardState: messages.forwardState,
        providerErrorCode: messages.providerErrorCode,
      })
      .from(messages)
    const aliases = await db.select({ id: replyAliases.id }).from(replyAliases)

    expect(result.kind).toBe('captured')
    expect(storedMailbox?.forwardTo).toBeNull()
    expect(projected).toEqual({ forwardState: 'not_applicable', providerErrorCode: null })
    expect(aliases).toEqual([])
    expect(runtime.sent).toEqual([])
  })
})
