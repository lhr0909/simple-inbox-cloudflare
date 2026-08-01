/// <reference types="node" />

import type { DatabaseSync } from 'node:sqlite'

export const SHA_A = 'a'.repeat(64)
export const SHA_B = 'b'.repeat(64)
export const NOW = 1_785_571_200_000

export function insertUser(db: DatabaseSync, id: string, email: string): void {
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(id, email, NOW)
}

export function insertMailbox(db: DatabaseSync, id: string, address: string): void {
  db.prepare(`
    INSERT INTO mailboxes (id, address, sender_alias, forward_to, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?)
  `).run(id, address, NOW, NOW)
}

export function insertMember(db: DatabaseSync, mailboxId: string, userId: string): void {
  db.prepare(`
    INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
    VALUES (?, ?, 'owner', ?)
  `).run(mailboxId, userId, NOW)
}

export function insertThread(
  db: DatabaseSync,
  id: string,
  mailboxId: string,
  lastMessageAt = NOW,
): void {
  db.prepare(`
    INSERT INTO threads (
      id, mailbox_id, subject, normalized_subject, workflow_state, archived_at,
      latest_message_id, last_message_at, last_message_preview,
      last_message_direction, last_sender_address, message_count, unread_count,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'needs_reply', NULL, NULL, ?, '', NULL, NULL, 0, 0, ?, ?)
  `).run(id, mailboxId, `Subject ${id}`, `subject ${id}`, lastMessageAt, NOW, NOW)
}

export function insertInboundMessage(
  db: DatabaseSync,
  id: string,
  mailboxId: string,
  threadId: string,
  sentAt = NOW,
): void {
  db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, thread_id, direction, ingest_digest,
      internet_message_id, provider_message_id, in_reply_to,
      from_address, from_name, subject, preview, text_body, html_body,
      html_policy, sent_at, received_at, raw_r2_key, raw_size, raw_sha256,
      read_at, send_state, forward_state, provider_error_code, retryability,
      send_attempted_at, forward_attempted_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'inbound', ?, ?, NULL, NULL,
      'sender@example.test', 'Synthetic Sender', 'Synthetic subject', 'Synthetic preview',
      'Synthetic body', NULL, 'none', ?, ?, ?, 128, ?, NULL,
      'not_applicable', 'not_applicable', NULL, 'not_retryable', NULL, NULL, ?, ?
    )
  `).run(
    id,
    mailboxId,
    threadId,
    id
      .padEnd(64, 'a')
      .slice(0, 64)
      .replaceAll(/[^0-9a-f]/gu, 'a'),
    `<${id}@example.test>`,
    sentAt,
    sentAt,
    `raw/inbound/2026/08/01/${id}.eml`,
    SHA_A,
    NOW,
    NOW,
  )
}

export function insertOutboundMessage(
  db: DatabaseSync,
  id: string,
  mailboxId: string,
  threadId: string,
  sentAt = NOW,
): void {
  db.prepare(`
    INSERT INTO messages (
      id, mailbox_id, thread_id, direction, ingest_digest,
      internet_message_id, provider_message_id, in_reply_to,
      from_address, from_name, subject, preview, text_body, html_body,
      html_policy, sent_at, received_at, raw_r2_key, raw_size, raw_sha256,
      read_at, send_state, forward_state, provider_error_code, retryability,
      send_attempted_at, forward_attempted_at, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'outbound', NULL, ?, ?, NULL,
      'owner@example.test', 'Synthetic Owner', 'Synthetic reply', 'Synthetic outbound preview',
      'Synthetic outbound body', NULL, 'none', ?, NULL, ?, 128, ?, NULL,
      'sent', 'not_applicable', NULL, 'not_retryable', ?, NULL, ?, ?
    )
  `).run(
    id,
    mailboxId,
    threadId,
    `<${id}@example.test>`,
    `provider-${id}`,
    sentAt,
    `raw/outbound/2026/08/01/${id}.eml`,
    SHA_B,
    sentAt,
    NOW,
    NOW,
  )
}
