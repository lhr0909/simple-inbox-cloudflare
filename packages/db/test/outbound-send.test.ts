import { afterEach, describe, expect, it } from 'vitest'

import { OutboundSendRepository } from '../src/repositories/outbound-send'
import { insertMailbox, insertMember, insertUser, NOW, SHA_A, SHA_B } from './support/fixtures'
import { TestD1Database } from './support/d1'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('OutboundSendRepository', () => {
  it('reserves once, replays the same digest, and rejects conflicting reuse', async () => {
    const { repository } = setup()
    const input = {
      actorUserId: 'user_owner',
      createdAt: NOW,
      id: 'send_one',
      idempotencyKey: 'synthetic-key-0001',
      mailboxId: 'mailbox_owner',
      requestDigest: SHA_A,
      threadId: null,
    } as const

    const reserved = await repository.reserve(input)
    expect(reserved).toMatchObject({ kind: 'reserved', send: { id: 'send_one', state: 'queued' } })
    expect(await repository.reserve({ ...input, id: 'send_ignored' })).toMatchObject({
      kind: 'replay',
      send: { id: 'send_one', requestDigest: SHA_A },
    })
    expect(
      await repository.reserve({ ...input, id: 'send_conflict', requestDigest: SHA_B }),
    ).toEqual({ kind: 'conflict' })
  })

  it('cannot reserve or read through a mailbox without current membership', async () => {
    const { repository } = setup()
    const result = await repository.reserve({
      actorUserId: 'user_intruder',
      createdAt: NOW,
      id: 'send_intruder',
      idempotencyKey: 'synthetic-key-0002',
      mailboxId: 'mailbox_owner',
      requestDigest: SHA_A,
      threadId: null,
    })
    expect(result).toEqual({ kind: 'conflict' })
    expect(
      await repository.getByIdempotencyKey('synthetic-key-0001', 'user_intruder', 'mailbox_owner'),
    ).toBeUndefined()
  })

  it('claims queued delivery exactly once and makes the in-flight state manual-only', async () => {
    const { repository, testDb } = setup()
    const input = {
      actorUserId: 'user_owner',
      createdAt: NOW,
      id: 'send_claimed',
      idempotencyKey: 'synthetic-key-claim',
      mailboxId: 'mailbox_owner',
      requestDigest: SHA_A,
      threadId: null,
    } as const
    await repository.reserve(input)
    const claim = {
      actorUserId: input.actorUserId,
      id: input.id,
      mailboxId: input.mailboxId,
      now: NOW + 1,
      requestDigest: input.requestDigest,
    }

    expect(await repository.claimQueuedSend(claim)).toBe(true)
    expect(await repository.claimQueuedSend({ ...claim, now: NOW + 2 })).toBe(false)
    expect(
      await repository.getByIdempotencyKey(
        input.idempotencyKey,
        input.actorUserId,
        input.mailboxId,
      ),
    ).toMatchObject({
      attemptCount: 1,
      retryability: 'manual_confirmation_required',
      state: 'sending',
    })
    expect(() =>
      testDb.sqlite
        .prepare("UPDATE outbound_sends SET retryability = 'retryable' WHERE id = 'send_claimed'")
        .run(),
    ).toThrow()
  })

  it('creates a new thread with its reservation and does not create another on replay', async () => {
    const { repository, testDb } = setup()
    const input = {
      actorUserId: 'user_owner',
      createdAt: NOW,
      id: 'send_new_thread',
      idempotencyKey: 'synthetic-new-thread-key',
      mailboxId: 'mailbox_owner',
      newThread: newThread('thread_new'),
      requestDigest: SHA_A,
      threadId: 'thread_new',
    } as const

    expect(await repository.reserve(input)).toMatchObject({
      kind: 'reserved',
      send: { threadId: 'thread_new' },
    })
    expect(
      await repository.reserve({
        ...input,
        id: 'send_replay_ignored',
        newThread: newThread('thread_replay_ignored'),
        threadId: 'thread_replay_ignored',
      }),
    ).toMatchObject({ kind: 'replay', send: { threadId: 'thread_new' } })
    expect(testDb.sqlite.prepare('SELECT id FROM threads').all()).toEqual([{ id: 'thread_new' }])
  })

  it('rolls new-thread creation back when its reservation statement faults', async () => {
    const { repository, testDb } = setup()
    await repository.reserve({
      actorUserId: 'user_owner',
      createdAt: NOW,
      id: 'send_primary_collision',
      idempotencyKey: 'synthetic-existing-key',
      mailboxId: 'mailbox_owner',
      requestDigest: SHA_A,
      threadId: null,
    })

    await expect(
      repository.reserve({
        actorUserId: 'user_owner',
        createdAt: NOW,
        id: 'send_primary_collision',
        idempotencyKey: 'synthetic-collision-key',
        mailboxId: 'mailbox_owner',
        newThread: newThread('thread_must_rollback'),
        requestDigest: SHA_B,
        threadId: 'thread_must_rollback',
      }),
    ).rejects.toThrow()
    expect(testDb.sqlite.prepare('SELECT count(*) AS count FROM threads').get()).toEqual({
      count: 0,
    })
  })
})

function newThread(id: string) {
  return {
    createdAt: NOW,
    id,
    lastMessageAt: NOW,
    mailboxId: 'mailbox_owner',
    normalizedSubject: 'synthetic subject',
    subject: 'Synthetic subject',
    updatedAt: NOW,
    workflowState: 'waiting' as const,
  }
}

function setup(): { repository: OutboundSendRepository; testDb: TestD1Database } {
  const testDb = new TestD1Database()
  databases.push(testDb)
  insertUser(testDb.sqlite, 'user_owner', 'owner@example.test')
  insertUser(testDb.sqlite, 'user_intruder', 'intruder@example.test')
  insertMailbox(testDb.sqlite, 'mailbox_owner', 'inbox@example.test')
  insertMember(testDb.sqlite, 'mailbox_owner', 'user_owner')
  return { repository: new OutboundSendRepository(testDb.asD1()), testDb }
}
