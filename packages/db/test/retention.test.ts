/// <reference types="node" />

import { afterEach, describe, expect, it } from 'vitest'

import { MailboxScopedRepository } from '../src/repositories/scoped-inbox'
import { MAX_RETENTION_BATCH_SIZE, RetentionRepository } from '../src/repositories/retention'
import { TestD1Database } from './support/d1'
import {
  insertInboundMessage,
  insertMailbox,
  insertMember,
  insertOutboundMessage,
  insertThread,
  insertUser,
  NOW,
} from './support/fixtures'

const DAY = 86_400_000
const RUN_NOW = NOW + 2 * DAY
const USER_ID = 'retention_user'
const MAILBOX_ID = 'retention_mailbox'
const THREAD_ID = 'retention_thread'
const CLAIM_TOKEN = 'retention-claim-token-0001'
const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})

describe('RetentionRepository', () => {
  it('anchors retention to trusted local creation time rather than the RFC 822 date', async () => {
    const { database, repository } = fixture()
    insertInboundMessage(database.sqlite, 'retention_old_header_date', MAILBOX_ID, THREAD_ID, 1)

    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: NOW + DAY - 1,
        rawRetentionDays: 1,
      }),
    ).toBe(0)
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 1,
    })
  })

  it('enforces policy constraints and creates one idempotent tombstone per message', async () => {
    const { database, repository } = fixture()
    const messageId = 'retention_message_a'
    insertInboundMessage(database.sqlite, messageId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)

    await expect(
      repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: RUN_NOW,
        rawRetentionDays: 2,
      }),
    ).rejects.toThrow('Application-record retention')
    await expect(
      repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: MAX_RETENTION_BATCH_SIZE + 1,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).rejects.toThrow('batch size')

    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(1)
    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(0)

    const tombstone = await repository.getById(messageId)
    expect(tombstone).toMatchObject({
      applicationDeleteAfter: NOW + DAY,
      attemptCount: 0,
      claimToken: null,
      messageId,
      rawDeleteAfter: NOW + DAY,
      state: 'raw_pending',
    })
    expect(() =>
      database.sqlite
        .prepare("UPDATE retention_tombstones SET state = 'completed' WHERE id = ?")
        .run(messageId),
    ).toThrow()
  })

  it('bounds every claim to 100 records and leases each record once', async () => {
    const { database, repository } = fixture()
    for (let index = 0; index < 105; index += 1) {
      insertOutboundMessage(
        database.sqlite,
        `retention_batch_${index.toString().padStart(3, '0')}`,
        MAILBOX_ID,
        THREAD_ID,
        NOW - 2 * DAY,
      )
    }

    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 100,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(100)
    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 100,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(5)

    const first = await repository.claimEligible({
      claimToken: 'retention-batch-claim-token-0001',
      leaseMs: 60_000,
      limit: 100,
      now: RUN_NOW,
    })
    const second = await repository.claimEligible({
      claimToken: 'retention-batch-claim-token-0002',
      leaseMs: 60_000,
      limit: 100,
      now: RUN_NOW,
    })
    expect(first).toHaveLength(100)
    expect(second).toHaveLength(5)
    expect(new Set([...first, ...second].map(({ id }) => id))).toHaveLength(105)
    expect(first.every(({ attemptCount }) => attemptCount === 1)).toBe(true)
  })

  it('does not claim a shared raw object until every retained reference has a tombstone', async () => {
    const { database, repository } = fixture()
    const firstId = 'retention_shared_first'
    const secondId = 'retention_shared_second'
    const sharedKey = `raw/inbound/2026/08/01/${'d'.repeat(64)}.eml`
    insertOutboundMessage(database.sqlite, firstId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    insertOutboundMessage(database.sqlite, secondId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    database.sqlite
      .prepare('UPDATE messages SET raw_r2_key = ?, raw_sha256 = ? WHERE id IN (?, ?)')
      .run(sharedKey, 'd'.repeat(64), firstId, secondId)

    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(1)
    expect(
      await repository.claimEligible({
        claimToken: 'retention-shared-claim-token-0001',
        leaseMs: 60_000,
        limit: 1,
        now: RUN_NOW,
      }),
    ).toEqual([])

    expect(
      await repository.enqueueEligible({
        applicationRetentionDays: 1,
        limit: 1,
        now: RUN_NOW,
        rawRetentionDays: 1,
      }),
    ).toBe(1)
    expect(
      await repository.claimEligible({
        claimToken: 'retention-shared-claim-token-0002',
        leaseMs: 60_000,
        limit: 1,
        now: RUN_NOW,
      }),
    ).toHaveLength(1)
  })

  it('retires raw access while retaining application records until their later deadline', async () => {
    const { database, repository } = fixture()
    const messageId = 'retention_split_window'
    insertInboundMessage(database.sqlite, messageId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    setThreadAggregate(database, messageId, 1, 1)
    const rawRunAt = NOW + DAY + 1
    await repository.enqueueEligible({
      applicationRetentionDays: 2,
      limit: 1,
      now: rawRunAt,
      rawRetentionDays: 1,
    })
    const [claim] = await repository.claimEligible({
      claimToken: 'retention-split-window-token-0001',
      leaseMs: 60_000,
      limit: 1,
      now: rawRunAt,
    })
    if (claim === undefined) throw new Error('Expected a raw-retention claim.')
    expect(claim.applicationDeleteAfter).toBe(NOW + 2 * DAY)
    await repository.markRawDeleted({
      id: claim.id,
      keepClaim: false,
      now: rawRunAt,
      token: claim.claimToken,
    })

    const scoped = new MailboxScopedRepository(database.asD1(), { userId: USER_ID })
    expect(await scoped.listThreadMessages(THREAD_ID)).toEqual([
      expect.objectContaining({ id: messageId, rawAvailable: false }),
    ])
    expect(await scoped.getRawMessage(messageId)).toBeUndefined()
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 1,
    })
    expect(await repository.getById(messageId)).toMatchObject({
      claimToken: null,
      state: 'application_pending',
    })
  })

  it('completes child cleanup, deletes an empty thread, and preserves unknown send evidence', async () => {
    const { database, repository } = fixture()
    const messageId = 'retention_unknown_message'
    insertOutboundMessage(database.sqlite, messageId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    setThreadAggregate(database, messageId, 1, 0)
    insertProjectionChildren(database, messageId)
    database.sqlite
      .prepare(`
        INSERT INTO outbound_sends (
          id, idempotency_key, actor_user_id, mailbox_id, thread_id,
          request_digest, state, message_id, provider_message_id,
          provider_error_code, retryability, attempt_count, last_attempted_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, NULL, 'provider_send_unknown',
          'manual_confirmation_required', 1, ?, ?, ?)
      `)
      .run(
        'retention_send',
        'retention-unknown-send-0001',
        USER_ID,
        MAILBOX_ID,
        THREAD_ID,
        'c'.repeat(64),
        messageId,
        NOW - 2 * DAY,
        NOW - 2 * DAY,
        NOW - 2 * DAY,
      )

    const claim = await enqueueAndClaim(repository, messageId)
    expect(
      await repository.markRawDeleted({
        id: claim.id,
        keepClaim: true,
        now: RUN_NOW,
        token: claim.claimToken,
      }),
    ).toBe(true)
    expect(
      await repository.completeApplicationDeletion({
        id: claim.id,
        mailboxId: claim.mailboxId,
        messageId: claim.messageId,
        now: RUN_NOW,
        threadId: claim.threadId,
        token: claim.claimToken,
      }),
    ).toBe(true)

    expect(database.sqlite.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
      count: 0,
    })
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM threads').get()).toEqual({
      count: 0,
    })
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
      count: 0,
    })
    expect(database.sqlite.prepare('SELECT count(*) AS count FROM message_search').get()).toEqual({
      count: 0,
    })
    expect(
      database.sqlite
        .prepare(`
          SELECT state, message_id AS messageId, thread_id AS threadId, idempotency_key AS key
          FROM outbound_sends
        `)
        .get(),
    ).toEqual({
      key: 'retention-unknown-send-0001',
      messageId: null,
      state: 'unknown',
      threadId: null,
    })
    expect(await repository.getById(messageId)).toMatchObject({
      applicationDeletedAt: RUN_NOW,
      attemptCount: 1,
      claimToken: null,
      completedAt: RUN_NOW,
      lastErrorCode: null,
      rawDeletedAt: RUN_NOW,
      state: 'completed',
    })
  })

  it('keeps safe failure and attempt history after a later successful completion', async () => {
    const { database, repository } = fixture()
    const messageId = 'retention_retry_history'
    insertInboundMessage(database.sqlite, messageId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    setThreadAggregate(database, messageId, 1, 1)
    const first = await enqueueAndClaim(repository, messageId)
    expect(
      await repository.recordFailure({
        errorCode: 'r2_delete_failed',
        id: first.id,
        now: RUN_NOW,
        token: first.claimToken,
      }),
    ).toBe(true)
    const [second] = await repository.claimEligible({
      claimToken: 'retention-retry-claim-token-0002',
      leaseMs: 60_000,
      limit: 1,
      now: RUN_NOW + 1,
    })
    if (second === undefined) throw new Error('Expected a retry claim.')
    await repository.markRawDeleted({
      id: second.id,
      keepClaim: true,
      now: RUN_NOW + 1,
      token: second.claimToken,
    })
    await repository.completeApplicationDeletion({
      id: second.id,
      mailboxId: second.mailboxId,
      messageId: second.messageId,
      now: RUN_NOW + 1,
      threadId: second.threadId,
      token: second.claimToken,
    })

    expect(await repository.getById(messageId)).toMatchObject({
      attemptCount: 2,
      completedAt: RUN_NOW + 1,
      lastErrorCode: 'r2_delete_failed',
      lastFailedAt: RUN_NOW,
      state: 'completed',
    })
  })

  it('repairs all thread aggregates when retained messages remain', async () => {
    const { database, repository } = fixture()
    const expiredId = 'retention_expired_message'
    const retainedId = 'retention_retained_message'
    insertInboundMessage(database.sqlite, expiredId, MAILBOX_ID, THREAD_ID, NOW - 3 * DAY)
    insertOutboundMessage(database.sqlite, retainedId, MAILBOX_ID, THREAD_ID, NOW - 2 * DAY)
    setThreadAggregate(database, retainedId, 2, 1)

    const claim = await enqueueAndClaim(repository, expiredId)
    await repository.markRawDeleted({
      id: claim.id,
      keepClaim: true,
      now: RUN_NOW,
      token: claim.claimToken,
    })
    await repository.completeApplicationDeletion({
      id: claim.id,
      mailboxId: claim.mailboxId,
      messageId: claim.messageId,
      now: RUN_NOW,
      threadId: claim.threadId,
      token: claim.claimToken,
    })

    expect(
      database.sqlite
        .prepare(`
          SELECT
            latest_message_id AS latestMessageId,
            last_message_at AS lastMessageAt,
            last_message_direction AS lastDirection,
            last_sender_address AS lastSender,
            message_count AS messageCount,
            unread_count AS unreadCount
          FROM threads WHERE id = ?
        `)
        .get(THREAD_ID),
    ).toEqual({
      lastDirection: 'outbound',
      lastMessageAt: NOW - 2 * DAY,
      lastSender: 'owner@example.test',
      latestMessageId: retainedId,
      messageCount: 1,
      unreadCount: 0,
    })
  })
})

function fixture(): { database: TestD1Database; repository: RetentionRepository } {
  const database = new TestD1Database()
  databases.push(database)
  insertUser(database.sqlite, USER_ID, 'retention-owner@example.test')
  insertMailbox(database.sqlite, MAILBOX_ID, 'retention@example.test')
  insertMember(database.sqlite, MAILBOX_ID, USER_ID)
  insertThread(database.sqlite, THREAD_ID, MAILBOX_ID)
  return { database, repository: new RetentionRepository(database.asD1()) }
}

async function enqueueAndClaim(repository: RetentionRepository, messageId: string) {
  await repository.enqueueEligible({
    applicationRetentionDays: 1,
    limit: 100,
    now: RUN_NOW,
    rawRetentionDays: 1,
  })
  const claims = await repository.claimEligible({
    claimToken: CLAIM_TOKEN,
    leaseMs: 60_000,
    limit: 100,
    now: RUN_NOW,
  })
  const claim = claims.find(({ id }) => id === messageId)
  if (claim === undefined) throw new Error(`Missing claim for ${messageId}`)
  return claim
}

function setThreadAggregate(
  database: TestD1Database,
  latestMessageId: string,
  messageCount: number,
  unreadCount: number,
): void {
  const latest = database.sqlite
    .prepare('SELECT sent_at, preview, direction, from_address FROM messages WHERE id = ?')
    .get(latestMessageId)
  database.sqlite
    .prepare(`
      UPDATE threads
      SET
        latest_message_id = ?, last_message_at = ?, last_message_preview = ?,
        last_message_direction = ?, last_sender_address = ?,
        message_count = ?, unread_count = ?
      WHERE id = ?
    `)
    .run(
      latestMessageId,
      Number(latest?.['sent_at']),
      String(latest?.['preview']),
      String(latest?.['direction']),
      String(latest?.['from_address']),
      messageCount,
      unreadCount,
      THREAD_ID,
    )
}

function insertProjectionChildren(database: TestD1Database, messageId: string): void {
  database.sqlite
    .prepare(`
      INSERT INTO message_recipients (message_id, kind, position, address, display_name)
      VALUES (?, 'to', 0, 'recipient@example.test', NULL)
    `)
    .run(messageId)
  database.sqlite
    .prepare(`
      INSERT INTO message_references (message_id, position, internet_message_id)
      VALUES (?, 0, '<reference@example.test>')
    `)
    .run(messageId)
  database.sqlite
    .prepare(`
      INSERT INTO attachments (
        id, message_id, mime_ordinal, display_filename, media_type,
        size, disposition, content_id, created_at
      ) VALUES ('retention_attachment', ?, 0, 'fixture.txt', 'text/plain', 4, 'attachment', NULL, ?)
    `)
    .run(messageId, NOW - 2 * DAY)
  database.sqlite
    .prepare(`
      INSERT INTO message_search (
        message_id, thread_id, mailbox_id, subject, participants, body, tags, workflow_state
      ) VALUES (?, ?, ?, 'Synthetic', 'recipient', 'body', '', 'waiting')
    `)
    .run(messageId, THREAD_ID, MAILBOX_ID)
}
