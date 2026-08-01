import { afterEach, describe, expect, it } from 'vitest'

import {
  type InsertMessageProjectionInput,
  MailProjectionRepository,
} from '../src/repositories/mail-projection'
import { OutboundSendRepository } from '../src/repositories/outbound-send'
import { MailboxScopedRepository } from '../src/repositories/scoped-inbox'
import {
  insertMailbox,
  insertMember,
  insertThread,
  insertUser,
  NOW,
  SHA_A,
} from './support/fixtures'
import { TestD1Database } from './support/d1'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('MailProjectionRepository', () => {
  it('atomically inserts normalized children, aggregates, and the FTS document', async () => {
    const testDb = setup()
    const projection = new MailProjectionRepository(testDb.asD1())
    await projection.insertMessageProjection(messageProjection('message_one'))

    expect(
      testDb.sqlite
        .prepare(`
          SELECT latest_message_id, message_count, unread_count,
                 last_message_direction, last_sender_address
          FROM threads WHERE id = 'thread_owner'
        `)
        .get(),
    ).toEqual({
      last_message_direction: 'inbound',
      last_sender_address: 'sender@example.test',
      latest_message_id: 'message_one',
      message_count: 1,
      unread_count: 1,
    })
    expect(
      testDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM message_search WHERE message_search MATCH 'synthetic'",
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
      count: 1,
    })

    testDb.sqlite
      .prepare(`
      INSERT INTO tags (id, mailbox_id, name, normalized_name, created_at)
      VALUES ('tag_important', 'mailbox_owner', 'Important', 'important', ?)
    `)
      .run(NOW)
    await projection.replaceThreadTags(
      'mailbox_owner',
      'thread_owner',
      ['tag_important'],
      ['important'],
      NOW + 1,
    )
    expect(
      testDb.sqlite
        .prepare(
          "SELECT count(*) AS count FROM message_search WHERE message_search MATCH 'important'",
        )
        .get(),
    ).toEqual({ count: 1 })

    const scoped = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    const detail = await scoped.getThreadDetail('thread_owner')
    expect(detail?.thread).toMatchObject({
      attachmentCount: 1,
      messageCount: 1,
      participants: [
        { address: 'owner@example.test', displayName: null },
        { address: 'sender@example.test', displayName: 'Synthetic Sender' },
      ],
      tags: [{ name: 'Important' }],
      unreadCount: 1,
    })
    expect(detail?.messages[0]).toMatchObject({
      attachments: [
        {
          disposition: 'unknown',
          filename: 'synthetic.txt',
          ordinal: 0,
        },
      ],
      from: { address: 'sender@example.test', displayName: 'Synthetic Sender' },
      rawAvailable: true,
      recipients: [
        {
          address: 'owner@example.test',
          displayName: null,
          kind: 'to',
          position: 0,
        },
      ],
      references: ['<prior@example.test>'],
    })
  })

  it('rolls the complete batch back when a child constraint fails', async () => {
    const testDb = setup()
    const projection = new MailProjectionRepository(testDb.asD1())
    const input = messageProjection('message_rollback')
    input.recipients = [
      ...input.recipients,
      { address: 'owner@example.test', displayName: null, kind: 'to', position: 1 },
    ]

    await expect(projection.insertMessageProjection(input)).rejects.toThrow()
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 0,
    })
    expect(testDb.sqlite.prepare('SELECT message_count FROM threads').get()).toEqual({
      message_count: 0,
    })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM message_search').get()).toEqual({
      count: 0,
    })
  })

  it('rejects multibyte bodies that exceed the conservative D1 row budget', async () => {
    const testDb = setup()
    const projection = new MailProjectionRepository(testDb.asD1())
    const input = messageProjection('message_multibyte_body')
    // 750,002 UTF-16 code units pass the legacy character check, while the
    // encoded body is 1,500,004 bytes and cannot leave safe D1 row overhead.
    input.message.textBody = '😀'.repeat(375_001)

    await expect(projection.insertMessageProjection(input)).rejects.toThrow(
      'at most 1,500,000 UTF-8 bytes combined',
    )
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 0,
    })
  })

  it('chunks the maximum public projection cardinalities into an operational D1 batch', async () => {
    const testDb = setup()
    const projection = new MailProjectionRepository(testDb.asD1())
    const input = messageProjection('message_bounded_batch')
    input.recipients = Array.from({ length: 200 }, (_, position) => ({
      address: `recipient-${position}@example.test`,
      displayName: null,
      kind: 'to' as const,
      position,
    }))
    input.references = Array.from({ length: 100 }, (_, position) => ({
      internetMessageId: `<reference-${position}@example.test>`,
      position,
    }))
    input.attachments = Array.from({ length: 100 }, (_, mimeOrdinal) => ({
      contentId: null,
      createdAt: NOW + 1,
      displayFilename: `attachment-${mimeOrdinal}.txt`,
      disposition: 'attachment' as const,
      id: `attachment_bounded_${mimeOrdinal}`,
      mediaType: 'text/plain',
      mimeOrdinal,
      size: 1,
    }))

    await projection.insertMessageProjection(input)

    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM message_recipients').get()).toEqual(
      {
        count: 200,
      },
    )
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM message_references').get()).toEqual(
      {
        count: 100,
      },
    )
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
      count: 100,
    })
  })

  it('atomically creates a new inbound thread, projects its message, and sets workflow', async () => {
    const testDb = setupWithoutThread()
    const projection = new MailProjectionRepository(testDb.asD1())
    await projection.insertInboundProjection({
      newThread: newThread(),
      projection: messageProjection('message_atomic_inbound'),
    })

    expect(
      testDb.sqlite
        .prepare('SELECT message_count, unread_count, workflow_state FROM threads')
        .get(),
    ).toEqual({ message_count: 1, unread_count: 1, workflow_state: 'needs_reply' })
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 1,
    })
  })

  it('atomically projects an outbound result, updates workflow, and finalizes its claimed send', async () => {
    const testDb = setup()
    const binding = testDb.asD1()
    const projection = new MailProjectionRepository(binding)
    await projection.insertInboundProjection({
      projection: messageProjection('message_prior_inbound'),
    })
    const send = await reserveClaimedSend(testDb, 'send_atomic_success')
    const outbound = outboundProjection('message_atomic_outbound')

    await projection.completeOutboundProjection({
      actorUserId: 'user_owner',
      now: NOW + 3,
      outboundSendId: send.id,
      projection: outbound,
      requestDigest: SHA_A,
    })

    expect(
      testDb.sqlite
        .prepare('SELECT message_id, state, retryability FROM outbound_sends WHERE id = ?')
        .get(send.id),
    ).toEqual({
      message_id: 'message_atomic_outbound',
      retryability: 'not_retryable',
      state: 'sent',
    })
    expect(
      testDb.sqlite
        .prepare('SELECT message_count, unread_count, workflow_state FROM threads')
        .get(),
    ).toEqual({ message_count: 2, unread_count: 0, workflow_state: 'waiting' })
    expect(
      testDb.sqlite
        .prepare("SELECT read_at FROM messages WHERE id = 'message_prior_inbound'")
        .get(),
    ).toEqual({ read_at: NOW + 3 })
  })

  it('rolls every outbound completion mutation back when any projection child faults', async () => {
    const testDb = setup()
    const binding = testDb.asD1()
    const projection = new MailProjectionRepository(binding)
    await projection.insertInboundProjection({
      projection: messageProjection('message_prior_for_fault'),
    })
    const send = await reserveClaimedSend(testDb, 'send_atomic_fault')
    const outbound = outboundProjection('message_atomic_fault')
    outbound.recipients = [
      ...outbound.recipients,
      { address: 'recipient@example.test', displayName: null, kind: 'to', position: 1 },
    ]

    await expect(
      projection.completeOutboundProjection({
        actorUserId: 'user_owner',
        now: NOW + 3,
        outboundSendId: send.id,
        projection: outbound,
        requestDigest: SHA_A,
      }),
    ).rejects.toThrow()

    expect(
      testDb.sqlite
        .prepare('SELECT message_id, state, retryability FROM outbound_sends WHERE id = ?')
        .get(send.id),
    ).toEqual({
      message_id: null,
      retryability: 'manual_confirmation_required',
      state: 'sending',
    })
    expect(
      testDb.sqlite
        .prepare('SELECT message_count, unread_count, workflow_state FROM threads')
        .get(),
    ).toEqual({ message_count: 1, unread_count: 1, workflow_state: 'needs_reply' })
    expect(
      testDb.sqlite
        .prepare("SELECT count(*) AS count FROM messages WHERE direction = 'outbound'")
        .get(),
    ).toEqual({ count: 0 })
  })
})

function setup(): TestD1Database {
  const testDb = new TestD1Database()
  databases.push(testDb)
  insertUser(testDb.sqlite, 'user_owner', 'owner@example.test')
  insertMailbox(testDb.sqlite, 'mailbox_owner', 'inbox@example.test')
  insertMember(testDb.sqlite, 'mailbox_owner', 'user_owner')
  insertThread(testDb.sqlite, 'thread_owner', 'mailbox_owner', NOW)
  return testDb
}

function setupWithoutThread(): TestD1Database {
  const testDb = new TestD1Database()
  databases.push(testDb)
  insertUser(testDb.sqlite, 'user_owner', 'owner@example.test')
  insertMailbox(testDb.sqlite, 'mailbox_owner', 'inbox@example.test')
  insertMember(testDb.sqlite, 'mailbox_owner', 'user_owner')
  return testDb
}

function newThread() {
  return {
    createdAt: NOW,
    id: 'thread_owner',
    lastMessageAt: NOW,
    mailboxId: 'mailbox_owner',
    normalizedSubject: 'synthetic subject',
    subject: 'Synthetic subject',
    updatedAt: NOW,
    workflowState: 'needs_reply' as const,
  }
}

async function reserveClaimedSend(testDb: TestD1Database, id: string) {
  const repository = new OutboundSendRepository(testDb.asD1())
  const reserved = await repository.reserve({
    actorUserId: 'user_owner',
    createdAt: NOW + 2,
    id,
    idempotencyKey: `synthetic-${id}`,
    mailboxId: 'mailbox_owner',
    requestDigest: SHA_A,
    threadId: 'thread_owner',
  })
  if (reserved.kind !== 'reserved') throw new Error('Synthetic send was not reserved.')
  const claimed = await repository.claimQueuedSend({
    actorUserId: 'user_owner',
    id,
    mailboxId: 'mailbox_owner',
    now: NOW + 2,
    requestDigest: SHA_A,
  })
  if (!claimed) throw new Error('Synthetic send was not claimed.')
  return reserved.send
}

function outboundProjection(id: string): InsertMessageProjectionInput {
  const input = messageProjection(id)
  input.attachments = []
  input.message = {
    ...input.message,
    direction: 'outbound',
    forwardState: 'not_applicable',
    fromAddress: 'owner@example.test',
    ingestDigest: null,
    internetMessageId: `<${id}@provider.example.test>`,
    providerMessageId: `<${id}@provider.example.test>`,
    readAt: null,
    receivedAt: null,
    sendAttemptedAt: NOW + 2,
    sendState: 'sent',
  }
  input.recipients = [
    { address: 'recipient@example.test', displayName: null, kind: 'to', position: 0 },
  ]
  return input
}

function messageProjection(id: string): InsertMessageProjectionInput {
  return {
    attachments: [
      {
        contentId: null,
        createdAt: NOW + 1,
        displayFilename: 'synthetic.txt',
        disposition: 'unknown',
        id: `attachment_${id}`,
        mediaType: 'text/plain',
        mimeOrdinal: 0,
        size: 16,
      },
    ],
    message: {
      createdAt: NOW + 1,
      direction: 'inbound',
      forwardAttemptedAt: null,
      forwardState: 'not_applicable',
      fromAddress: 'sender@example.test',
      fromName: 'Synthetic Sender',
      htmlBody: null,
      htmlPolicy: 'none',
      id,
      inReplyTo: '<prior@example.test>',
      ingestDigest: id
        .padEnd(64, 'a')
        .slice(0, 64)
        .replaceAll(/[^0-9a-f]/gu, 'a'),
      internetMessageId: `<${id}@example.test>`,
      mailboxId: 'mailbox_owner',
      preview: 'Synthetic preview',
      providerErrorCode: null,
      providerMessageId: null,
      rawR2Key: `raw/inbound/2026/08/01/${id}.eml`,
      rawSha256: SHA_A,
      rawSize: 256,
      readAt: null,
      receivedAt: NOW + 1,
      sendAttemptedAt: null,
      sendState: 'not_applicable',
      sentAt: NOW + 1,
      subject: 'Synthetic subject',
      textBody: 'Synthetic body',
      threadId: 'thread_owner',
      updatedAt: NOW + 1,
    },
    recipients: [{ address: 'owner@example.test', displayName: null, kind: 'to', position: 0 }],
    references: [{ internetMessageId: '<prior@example.test>', position: 0 }],
  }
}
