/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import {
  insertInboundMessage,
  insertMailbox,
  insertMember,
  insertThread,
  insertUser,
  NOW,
} from './support/fixtures'

const migrationsUrl = new URL('../migrations/', import.meta.url)
const openDatabases: DatabaseSync[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) {
    database.close()
  }
})

describe('reviewed D1 baseline migration', () => {
  it('uses trigger syntax accepted by the remote D1 migration splitter', () => {
    const baseline = readFileSync(new URL('0000_initial.sql', migrationsUrl), 'utf8')

    expect(baseline).not.toContain('\r')
    expect(baseline).not.toMatch(/\bSELECT\s+CASE\b/u)
    expect(baseline.match(/\bSELECT\s+\(CASE\b/gu)).toHaveLength(6)
  })

  it('migrates an empty SQLite database with foreign keys and FTS5', () => {
    const db = migratedDatabase()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
      .map((row) => String(row['name']))

    expect(tables).toEqual(
      expect.arrayContaining([
        'api_tokens',
        'attachments',
        'installations',
        'magic_links',
        'mailbox_members',
        'mailboxes',
        'message_recipients',
        'message_references',
        'message_search',
        'messages',
        'outbound_sends',
        'reply_aliases',
        'retention_tombstones',
        'sessions',
        'tags',
        'thread_tags',
        'threads',
        'users',
      ]),
    )
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])

    const searchDefinition = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'message_search'")
      .get()
    expect(String(searchDefinition?.['sql'])).toContain('USING fts5')
    expect(String(searchDefinition?.['sql'])).toContain('mailbox_id UNINDEXED')
  })

  it('checks normalization, aggregate bounds, direction state, and mailbox/thread ownership', () => {
    const db = migratedDatabase()
    expect(() => insertUser(db, 'user_upper', 'Owner@Example.test')).toThrow()

    insertUser(db, 'user_a', 'owner-a@example.test')
    insertMailbox(db, 'mailbox_a', 'inbox-a@example.test')
    insertMailbox(db, 'mailbox_b', 'inbox-b@example.test')
    insertMember(db, 'mailbox_a', 'user_a')
    insertThread(db, 'thread_a', 'mailbox_a')

    expect(() =>
      db.prepare("UPDATE threads SET unread_count = -1 WHERE id = 'thread_a'").run(),
    ).toThrow()
    expect(() => insertInboundMessage(db, 'message_cross', 'mailbox_b', 'thread_a')).toThrow()

    expect(() =>
      db
        .prepare(`
        INSERT INTO messages (
          id, mailbox_id, thread_id, direction, ingest_digest,
          from_address, subject, preview, html_policy, sent_at,
          raw_r2_key, raw_size, raw_sha256, read_at, send_state, forward_state,
          retryability, created_at, updated_at
        ) VALUES (
          'outbound_unread', 'mailbox_a', 'thread_a', 'outbound', NULL,
          'owner-a@example.test', 'Subject', 'Preview', 'none', ?,
          'raw/outbound/2026/08/01/outbound.eml', 10, ?, ?,
          'sent', 'not_applicable', 'not_retryable', ?, ?
        )
      `)
        .run(NOW, 'c'.repeat(64), NOW, NOW, NOW),
    ).toThrow()
  })

  it('synchronizes workflow state and deletion for FTS projections', () => {
    const db = migratedDatabase()
    insertUser(db, 'user_a', 'owner-a@example.test')
    insertMailbox(db, 'mailbox_a', 'inbox-a@example.test')
    insertMember(db, 'mailbox_a', 'user_a')
    insertThread(db, 'thread_a', 'mailbox_a')
    insertInboundMessage(db, 'message_a', 'mailbox_a', 'thread_a')
    db.prepare(`
      INSERT INTO message_search (
        message_id, thread_id, mailbox_id, subject, participants, body, tags, workflow_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'message_a',
      'thread_a',
      'mailbox_a',
      'Synthetic subject',
      'sender@example.test',
      'Synthetic body',
      'important',
      'needs_reply',
    )

    db.prepare("UPDATE threads SET workflow_state = 'resolved' WHERE id = 'thread_a'").run()
    expect(
      db.prepare("SELECT workflow_state FROM message_search WHERE message_id = 'message_a'").get(),
    ).toEqual({ workflow_state: 'resolved' })

    db.prepare("DELETE FROM messages WHERE id = 'message_a'").run()
    expect(db.prepare('SELECT count(*) AS count FROM message_search').get()).toEqual({ count: 0 })
  })

  it('contains all endpoint predicate indexes', () => {
    const db = migratedDatabase()
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((row) => String(row['name']))
    expect(indexes).toEqual(
      expect.arrayContaining([
        'mailbox_members_user_idx',
        'threads_mailbox_archive_order_idx',
        'threads_mailbox_workflow_archive_order_idx',
        'messages_thread_sent_idx',
        'messages_mailbox_internet_message_uidx',
        'messages_inbound_ingest_digest_uidx',
        'message_recipients_address_idx',
        'reply_aliases_local_part_uidx',
        'reply_aliases_message_destination_uidx',
        'retention_tombstones_state_claim_idx',
        'sessions_token_expiry_idx',
        'api_tokens_token_expiry_idx',
      ]),
    )
  })
})

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec('PRAGMA foreign_keys = ON')
  for (const migration of readdirSync(migrationsUrl)
    .filter((file) => file.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(new URL(migration, migrationsUrl), 'utf8'))
  }
  openDatabases.push(database)
  return database
}
