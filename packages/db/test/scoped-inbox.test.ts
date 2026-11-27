import { afterEach, describe, expect, it } from 'vitest'

import { SpamRuleRepository } from '../src/repositories/spam-rules'

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
  it('defaults HTML forwarding on, supports opting out independently, and enforces ownership', async () => {
    const database = setupTwoUsers()
    const owner = new MailboxScopedRepository(database.asD1(), { userId: 'user_owner' })
    expect(await owner.getMailboxSettings('mailbox_owner')).toMatchObject({
      forwardHtml: true,
      renderHtml: false,
    })
    expect(
      await owner.updateMailboxSettings('mailbox_owner', { forwardHtml: false }, NOW + 1),
    ).toBe(true)
    expect(await owner.getMailboxSettings('mailbox_owner')).toMatchObject({
      forwardHtml: false,
      renderHtml: false,
    })
    expect(await owner.updateMailboxSettings('mailbox_owner', { renderHtml: true }, NOW + 2)).toBe(
      true,
    )
    expect(
      await owner.updateMailboxSettings('mailbox_owner', { forwardHtml: false }, NOW + 3),
    ).toBe(true)
    expect((await owner.listMailboxes())[0]).toMatchObject({ forwardHtml: false, renderHtml: true })
    expect(
      await owner.updateMailboxSettings('mailbox_intruder', { renderHtml: true }, NOW + 4),
    ).toBe(false)
    const other = new MailboxScopedRepository(database.asD1(), { userId: 'user_intruder' })
    expect(await other.getMailboxSettings('mailbox_intruder')).toMatchObject({
      forwardHtml: true,
      renderHtml: false,
    })
  })

  it('persists sent-copy opt-out independently and restricts updates to the mailbox owner', async () => {
    const db = setupTwoUsers()
    const owner = new MailboxScopedRepository(db.asD1(), { userId: 'user_owner' })
    expect(await owner.getMailboxSettings('mailbox_owner')).toMatchObject({ forwardSent: true })
    expect(
      await owner.updateMailboxSettings('mailbox_owner', { forwardSent: false }, NOW + 1),
    ).toBe(true)
    expect((await owner.listMailboxes())[0]).toMatchObject({
      forwardSent: false,
      forwardHtml: true,
    })
    expect(
      await owner.updateMailboxSettings('mailbox_intruder', { forwardSent: false }, NOW + 1),
    ).toBe(false)
    const other = new MailboxScopedRepository(db.asD1(), { userId: 'user_intruder' })
    expect(await other.getMailboxSettings('mailbox_intruder')).toMatchObject({ forwardSent: true })
  })

  it('groups blocked mailboxes under Other inbound without changing messages or visibility preferences', async () => {
    const db = setupTwoUsers()
    const repo = new MailboxScopedRepository(db.asD1(), { userId: 'user_owner' })
    await repo.updateMailboxSettings('mailbox_owner', { whitelisted: true }, NOW)
    insertThread(db.sqlite, 'thread_blocked', 'mailbox_owner')
    insertInboundMessage(db.sqlite, 'message_blocked', 'mailbox_owner', 'thread_blocked', NOW)
    db.sqlite
      .prepare(`INSERT INTO message_search
      (message_id, thread_id, mailbox_id, subject, participants, body, tags, workflow_state)
      VALUES ('message_blocked', 'thread_blocked', 'mailbox_owner', 'Needle', '', '', '', 'needs_reply')`)
      .run()
    const before = await repo.getThreadDetail('thread_blocked')
    const ownerRules = new SpamRuleRepository(db.asD1(), 'user_owner')
    const otherRules = new SpamRuleRepository(db.asD1(), 'user_intruder')
    await otherRules.add({
      id: 'other_rule',
      kind: 'recipient',
      value: 'owner-inbox@example.test',
      createdAt: NOW,
    })
    await ownerRules.add({
      id: 'sender_rule',
      kind: 'sender',
      value: 'owner-inbox@example.test',
      createdAt: NOW,
    })
    expect((await repo.listMailboxes())[0]?.blocked).toBe(false)
    expect((await repo.listThreads({ mailboxId: 'other' })).items).toHaveLength(0)
    expect((await repo.searchThreads({ mailboxId: 'other', query: 'needle' })).items).toHaveLength(
      0,
    )
    await ownerRules.add({
      id: 'recipient_rule',
      kind: 'recipient',
      value: 'owner-inbox@example.test',
      createdAt: NOW,
    })
    expect(await repo.getMailboxSettings('mailbox_owner')).toMatchObject({
      blocked: true,
      whitelisted: true,
    })
    expect((await repo.listMailboxes())[0]).toMatchObject({ blocked: true, inboxCount: 1 })
    expect(
      (await repo.listThreads({ mailboxId: 'other' })).items.map((thread) => thread.id),
    ).toEqual(['thread_blocked'])
    expect(
      (await repo.searchThreads({ mailboxId: 'other', query: 'needle' })).items.map(
        (thread) => thread.id,
      ),
    ).toEqual(['thread_blocked'])
    expect(await repo.getThreadDetail('thread_blocked')).toEqual(before)
    await ownerRules.remove('recipient_rule')
    expect(await repo.getMailboxSettings('mailbox_owner')).toMatchObject({
      blocked: false,
      whitelisted: true,
    })
    expect((await repo.listThreads({ mailboxId: 'other' })).items).toHaveLength(0)
  })

  it('filters unauthorized mailboxes in the query and preserves stable cursor ordering', async () => {
    const testDb = setupTwoUsers()
    insertThread(testDb.sqlite, 'thread_older', 'mailbox_owner', NOW + 100)
    insertThread(testDb.sqlite, 'thread_newer_b', 'mailbox_owner', NOW + 200)
    insertThread(testDb.sqlite, 'thread_newer_a', 'mailbox_owner', NOW + 200)
    insertThread(testDb.sqlite, 'thread_secret', 'mailbox_intruder', NOW + 300)

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    for (const [id, time] of [
      ['thread_older', NOW + 100],
      ['thread_newer_b', NOW + 200],
      ['thread_newer_a', NOW + 200],
    ] as const)
      insertInboundMessage(testDb.sqlite, 'message_' + id, 'mailbox_owner', id, time)
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
    insertInboundMessage(testDb.sqlite, 'message_owner', 'mailbox_owner', 'thread_owner', NOW)
    insertThread(testDb.sqlite, 'thread_secret', 'mailbox_intruder')
    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })

    expect(await repository.setThreadArchived('thread_secret', NOW + 1, NOW + 1)).toBe(false)
    expect(await repository.setThreadArchived('thread_missing', NOW + 1, NOW + 1)).toBe(false)
    expect(await repository.setThreadArchived('thread_owner', NOW + 1, NOW + 1)).toBe(true)
    expect(
      testDb.sqlite.prepare("SELECT archived_at FROM threads WHERE id = 'thread_owner'").get(),
    ).toEqual({ archived_at: NOW + 1 })
  })

  it('keeps per-message flags independent, bounds read updates, and restores full Sent threads', async () => {
    const database = setupTwoUsers()
    insertThread(database.sqlite, 'conversation', 'mailbox_owner')
    insertInboundMessage(database.sqlite, 'a1', 'mailbox_owner', 'conversation', NOW)
    insertInboundMessage(database.sqlite, 'b2', 'mailbox_owner', 'conversation', NOW + 1)
    insertOutboundMessage(database.sqlite, 'c3', 'mailbox_owner', 'conversation', NOW + 2)
    const repo = new MailboxScopedRepository(database.asD1(), { userId: 'user_owner' })
    await repo.patchMessageState('conversation', { read: true, messageIds: ['a1'] }, NOW + 3)
    expect((await repo.getThread('conversation'))?.unreadCount).toBe(1)
    await repo.patchMessageState('conversation', { starred: true, messageIds: ['a1'] }, NOW + 4)
    await repo.patchMessageState('conversation', { location: 'archive' }, NOW + 5)
    expect((await repo.listThreads({ folder: 'inbox' })).items).toHaveLength(0)
    expect((await repo.listThreads({ folder: 'starred' })).items).toHaveLength(1)
    expect((await repo.listThreads({ folder: 'sent' })).items).toHaveLength(1)
    expect((await repo.getThreadDetail('conversation'))?.messages).toHaveLength(3)
    await repo.patchMessageState('conversation', { location: 'trash' }, NOW + 6)
    expect((await repo.listThreads({ folder: 'sent' })).items).toHaveLength(0)
    expect((await repo.listThreads({ folder: 'all' })).items).toHaveLength(0)
    expect((await repo.listThreads({ folder: 'trash' })).items).toHaveLength(1)
    await repo.patchMessageState('conversation', { location: 'restore' }, NOW + 7)
    expect((await repo.listThreads({ folder: 'sent' })).items).toHaveLength(1)
    expect((await repo.listThreads({ folder: 'inbox' })).items).toHaveLength(0)
    await repo.patchMessageState('conversation', { location: 'spam' }, NOW + 8)
    expect((await repo.listThreads({ folder: 'starred' })).items).toHaveLength(0)
    expect((await repo.listThreads({ folder: 'spam' })).items).toHaveLength(1)
    await repo.patchMessageState('conversation', { location: 'not_spam', read: false }, NOW + 9)
    expect((await repo.getThread('conversation'))?.unreadCount).toBe(2)
    expect((await repo.listThreads({ folder: 'inbox' })).items).toHaveLength(1)
    expect(
      await repo.patchMessageState(
        'conversation',
        { starred: true, messageIds: ['missing'] },
        NOW + 10,
      ),
    ).toBe(false)
  })

  it('keeps Sent conversations after a new inbound reply', async () => {
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

    expect(page.items.map(({ id }) => id)).toEqual(['thread_latest_inbound'])
    expect(mailbox?.sentCount).toBe(1)
  })

  it('bounds thread summary participants to 100 in address order while keeping ordinary threads unchanged', async () => {
    const testDb = setupTwoUsers()
    const insertRecipient = testDb.sqlite.prepare(`
      INSERT INTO message_recipients (message_id, kind, position, address, display_name)
      VALUES (?, ?, ?, ?, ?)
    `)

    insertThread(testDb.sqlite, 'thread_ordinary', 'mailbox_owner', NOW + 100)
    insertInboundMessage(
      testDb.sqlite,
      'message_ordinary',
      'mailbox_owner',
      'thread_ordinary',
      NOW + 100,
    )
    insertRecipient.run('message_ordinary', 'to', 0, 'gamma@example.test', 'Gamma')
    insertRecipient.run('message_ordinary', 'to', 1, 'alpha@example.test', 'Alpha')

    insertThread(testDb.sqlite, 'thread_many_single', 'mailbox_owner', NOW + 200)
    insertInboundMessage(
      testDb.sqlite,
      'message_many_single',
      'mailbox_owner',
      'thread_many_single',
      NOW + 200,
    )
    insertRecipient.run('message_many_single', 'to', 0, 'group@example.test', null)
    for (let index = 1; index <= 99; index += 1) {
      insertRecipient.run(
        'message_many_single',
        'to',
        index,
        `recipient-${String(index).padStart(2, '0')}@example.test`,
        null,
      )
    }
    insertRecipient.run('message_many_single', 'reply_to', 0, 'sender@example.test', null)

    insertThread(testDb.sqlite, 'thread_many_multi', 'mailbox_owner', NOW + 300)
    insertInboundMessage(
      testDb.sqlite,
      'message_many_multi_1',
      'mailbox_owner',
      'thread_many_multi',
      NOW + 250,
    )
    insertInboundMessage(
      testDb.sqlite,
      'message_many_multi_2',
      'mailbox_owner',
      'thread_many_multi',
      NOW + 300,
    )
    for (let index = 1; index <= 55; index += 1) {
      insertRecipient.run(
        'message_many_multi_1',
        'to',
        index - 1,
        `m1-${String(index).padStart(2, '0')}@example.test`,
        null,
      )
      insertRecipient.run(
        'message_many_multi_2',
        'to',
        index - 1,
        `m2-${String(index).padStart(2, '0')}@example.test`,
        null,
      )
    }

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    const ordinary = await repository.getThread('thread_ordinary')
    expect(ordinary?.participants).toEqual([
      { address: 'alpha@example.test', displayName: 'Alpha' },
      { address: 'gamma@example.test', displayName: 'Gamma' },
      { address: 'sender@example.test', displayName: 'Synthetic Sender' },
    ])

    const singleMessageMany = await repository.getThread('thread_many_single')
    expect(singleMessageMany?.participants).toHaveLength(100)
    expect(singleMessageMany?.participants[0]).toEqual({
      address: 'group@example.test',
      displayName: null,
    })
    expect(singleMessageMany?.participants.at(-1)).toEqual({
      address: 'recipient-99@example.test',
      displayName: null,
    })

    const multiMessageMany = await repository.getThread('thread_many_multi')
    expect(multiMessageMany?.participants).toHaveLength(100)
    expect(multiMessageMany?.participants[0]).toEqual({
      address: 'm1-01@example.test',
      displayName: null,
    })
  })

  it('bounds thread summary tags to 100 in normalized name order while keeping ordinary threads unchanged', async () => {
    const testDb = setupTwoUsers()
    const insertTag = testDb.sqlite.prepare(`
      INSERT INTO tags (id, mailbox_id, name, normalized_name, created_at)
      VALUES (?, 'mailbox_owner', ?, ?, ?)
    `)
    const insertThreadTag = testDb.sqlite.prepare(`
      INSERT INTO thread_tags (thread_id, tag_id, mailbox_id, created_at)
      VALUES (?, ?, 'mailbox_owner', ?)
    `)

    insertThread(testDb.sqlite, 'thread_few_tags', 'mailbox_owner', NOW + 100)
    insertInboundMessage(
      testDb.sqlite,
      'message_few_tags',
      'mailbox_owner',
      'thread_few_tags',
      NOW + 100,
    )
    insertTag.run('tag_b', 'Beta', 'beta', NOW)
    insertTag.run('tag_a', 'Alpha', 'alpha', NOW)
    insertThreadTag.run('thread_few_tags', 'tag_b', NOW)
    insertThreadTag.run('thread_few_tags', 'tag_a', NOW)

    insertThread(testDb.sqlite, 'thread_many_tags', 'mailbox_owner', NOW + 200)
    insertInboundMessage(
      testDb.sqlite,
      'message_many_tags',
      'mailbox_owner',
      'thread_many_tags',
      NOW + 200,
    )
    for (let index = 1; index <= 101; index += 1) {
      const label = `tag-${String(index).padStart(3, '0')}`
      insertTag.run(`tag_many_${index}`, label, label, NOW)
      insertThreadTag.run('thread_many_tags', `tag_many_${index}`, NOW)
    }

    const repository = new MailboxScopedRepository(testDb.asD1(), { userId: 'user_owner' })
    expect((await repository.getThread('thread_few_tags'))?.tags).toEqual([
      { name: 'Alpha' },
      { name: 'Beta' },
    ])

    const manyTags = await repository.getThread('thread_many_tags')
    expect(manyTags?.tags).toHaveLength(100)
    expect(manyTags?.tags[0]).toEqual({ name: 'tag-001' })
    expect(manyTags?.tags.at(-1)).toEqual({ name: 'tag-100' })
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
