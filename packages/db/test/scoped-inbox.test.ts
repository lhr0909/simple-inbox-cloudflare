import { afterEach, describe, expect, it } from 'vitest'

import { decodeThreadCursor } from '../src/cursor'
import { MailboxScopedRepository, normalizeFtsQuery } from '../src/repositories/scoped-inbox'
import {
  insertInboundMessage,
  insertMailbox,
  insertMember,
  insertOutboundMessage,
  insertThread,
  insertUser,
  NOW,
} from './support/fixtures'
import { TestD1Database } from './support/d1'

const databases: TestD1Database[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

describe('MailboxScopedRepository', () => {
  it('filters unauthorized mailboxes in the query and preserves stable cursor ordering', async () => {
    const testDb = setupTwoUsers()
    insertThread(testDb.sqlite, 'thread_older', 'mailbox_owner', NOW + 100)
    insertThread(testDb.sqlite, 'thread_newer_b', 'mailbox_owner', NOW + 200)
    insertThread(testDb.sqlite, 'thread_newer_a', 'mailbox_owner', NOW + 200)
    insertThread(testDb.sqlite, 'thread_secret', 'mailbox_intruder', NOW + 300)

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    const firstPage = await repository.listThreads({ limit: 2 })
    expect(firstPage.items.map(({ id }) => id)).toEqual(['thread_newer_b', 'thread_newer_a'])
    expect(firstPage.items.some(({ id }) => id === 'thread_secret')).toBe(false)
    expect(firstPage.nextCursor).not.toBeNull()
    expect(decodeThreadCursor(firstPage.nextCursor ?? '')).toEqual({
      id: 'thread_newer_a',
      lastMessageAt: NOW + 200,
    })

    const secondPage = await repository.listThreads({
      cursor: firstPage.nextCursor ?? '',
      limit: 2,
    })
    expect(secondPage.items.map(({ id }) => id)).toEqual(['thread_older'])
    expect(await repository.getThread('thread_secret')).toBeUndefined()
    expect(await repository.listThreadMessages('thread_secret')).toEqual([])
  })

  it('applies the same membership boundary to search, raw, and attachment reads', async () => {
    const testDb = setupTwoUsers()
    insertThread(testDb.sqlite, 'thread_owner', 'mailbox_owner', NOW + 100)
    insertThread(testDb.sqlite, 'thread_secret', 'mailbox_intruder', NOW + 200)
    insertInboundMessage(testDb.sqlite, 'message_owner', 'mailbox_owner', 'thread_owner', NOW + 100)
    insertInboundMessage(
      testDb.sqlite,
      'message_secret',
      'mailbox_intruder',
      'thread_secret',
      NOW + 200,
    )
    testDb.sqlite
      .prepare(`
      INSERT INTO attachments (
        id, message_id, mime_ordinal, display_filename, media_type,
        size, disposition, content_id, created_at
      ) VALUES ('attachment_secret', 'message_secret', 0, 'secret.txt', 'text/plain', 6, 'attachment', NULL, ?)
    `)
      .run(NOW)
    const insertSearch = testDb.sqlite.prepare(`
      INSERT INTO message_search (
        message_id, thread_id, mailbox_id, subject, participants, body, tags, workflow_state
      ) VALUES (?, ?, ?, ?, ?, ?, '', 'needs_reply')
    `)
    insertSearch.run(
      'message_owner',
      'thread_owner',
      'mailbox_owner',
      'Shared needle',
      'sender@example.test',
      'owner result',
    )
    insertSearch.run(
      'message_secret',
      'thread_secret',
      'mailbox_intruder',
      'Shared needle',
      'secret@example.test',
      'secret result',
    )

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    const results = await repository.searchThreads({ query: 'needle' })
    expect(results.items.map(({ id }) => id)).toEqual(['thread_owner'])
    expect(await repository.getRawMessage('message_secret')).toBeUndefined()
    expect(await repository.getAttachment('message_secret', 'attachment_secret')).toBeUndefined()
  })

  it('makes absent and unauthorized mutations indistinguishable', async () => {
    const testDb = setupTwoUsers()
    insertThread(testDb.sqlite, 'thread_owner', 'mailbox_owner')
    insertThread(testDb.sqlite, 'thread_secret', 'mailbox_intruder')
    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })

    expect(await repository.setThreadArchived('thread_secret', NOW + 1, NOW + 1)).toBe(false)
    expect(await repository.setThreadArchived('thread_missing', NOW + 1, NOW + 1)).toBe(false)
    expect(await repository.setThreadArchived('thread_owner', NOW + 1, NOW + 1)).toBe(true)
    expect(
      testDb.sqlite.prepare("SELECT archived_at FROM threads WHERE id = 'thread_owner'").get(),
    ).toEqual({ archived_at: NOW + 1 })
  })

  it('defines Sent by the latest message direction, not outbound history', async () => {
    const testDb = setupTwoUsers()
    insertThread(testDb.sqlite, 'thread_latest_outbound', 'mailbox_owner', NOW + 200)
    insertThread(testDb.sqlite, 'thread_latest_inbound', 'mailbox_owner', NOW + 100)
    insertOutboundMessage(
      testDb.sqlite,
      'message_historical_outbound',
      'mailbox_owner',
      'thread_latest_inbound',
      NOW + 50,
    )
    testDb.sqlite
      .prepare("UPDATE threads SET last_message_direction = 'outbound' WHERE id = ?")
      .run('thread_latest_outbound')
    testDb.sqlite
      .prepare("UPDATE threads SET last_message_direction = 'inbound' WHERE id = ?")
      .run('thread_latest_inbound')

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    const page = await repository.listThreads({ folder: 'sent' })
    const [mailbox] = await repository.listMailboxes()

    expect(page.items.map(({ id }) => id)).toEqual(['thread_latest_outbound'])
    expect(mailbox?.sentCount).toBe(1)
  })
})

describe('normalizeFtsQuery', () => {
  it('turns control syntax into bounded literal prefix terms', () => {
    expect(normalizeFtsQuery('alice@example.test OR "private"')).toBe(
      '"alice@example.test"* AND "or"* AND "private"*',
    )
    expect(() => normalizeFtsQuery('***')).toThrowError(
      'Search must contain at least one letter or number.',
    )
  })
})

function setupTwoUsers(): TestD1Database {
  const testDb = new TestD1Database()
  databases.push(testDb)
  insertUser(testDb.sqlite, 'user_owner', 'owner@example.test')
  insertUser(testDb.sqlite, 'user_intruder', 'intruder@example.test')
  insertMailbox(testDb.sqlite, 'mailbox_owner', 'owner-inbox@example.test')
  insertMailbox(testDb.sqlite, 'mailbox_intruder', 'intruder-inbox@example.test')
  insertMember(testDb.sqlite, 'mailbox_owner', 'user_owner')
  insertMember(testDb.sqlite, 'mailbox_intruder', 'user_intruder')
  return testDb
}
