import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm'

import { clampThreadPageSize, decodeThreadCursor, encodeThreadCursor } from '../cursor'
import { createInboxDatabase, type InboxDatabase } from '../database'
import type { DeliveryRetryability } from '../retryability'
import {
  attachments,
  mailboxMembers,
  mailboxes,
  messageRecipients,
  messageReferences,
  messages,
  tags,
  threadTags,
  threads,
} from '../schema'

export interface MessageStatePatch {
  read?: boolean | undefined
  starred?: boolean | undefined
  location?: 'inbox' | 'archive' | 'spam' | 'trash' | 'restore' | 'not_spam' | undefined
  messageIds?: string[] | undefined
}

export interface AuthenticatedActor {
  userId: string
}

export type ThreadFolder = 'inbox' | 'starred' | 'all' | 'archive' | 'spam' | 'trash' | 'sent'

export interface ListThreadsInput {
  cursor?: string
  folder?: ThreadFolder
  limit?: number
  mailboxId?: string
  unreadOnly?: boolean
}

export interface ThreadSummary {
  hasInbox: boolean
  hasSent: boolean
  hasStarred: boolean
  hasSpam: boolean
  hasTrash: boolean
  hasNormal: boolean
  archivedAt: number | null
  attachmentCount: number
  id: string
  lastMessageAt: number
  lastMessageDirection: string | null
  lastMessagePreview: string
  lastSenderAddress: string | null
  mailboxId: string
  messageCount: number
  normalizedSubject: string
  participants: ThreadParticipant[]
  subject: string
  tags: ThreadTagSummary[]
  unreadCount: number
  workflowState: string
}

export interface ThreadParticipant {
  address: string
  displayName: string | null
}

export interface ThreadTagSummary {
  name: string
}

export interface ThreadPage {
  items: ThreadSummary[]
  nextCursor: string | null
}

export interface SearchThreadsInput extends ListThreadsInput {
  query: string
}

export interface MailboxSummary {
  activeCount: number
  address: string
  archiveCount: number
  createdAt: number
  forwardHtml: boolean
  renderHtml: boolean
  whitelisted: boolean
  blocked: boolean
  forwardTo: string | null
  id: string
  inboxCount: number
  starredCount: number
  spamCount: number
  trashCount: number
  role: string
  senderAlias: string | null
  sentCount: number
  unreadCount: number
  updatedAt: number
}

export interface MailboxSettings {
  address: string
  forwardHtml: boolean
  renderHtml: boolean
  whitelisted: boolean
  blocked: boolean
  forwardTo: string | null
  id: string
  senderAlias: string | null
  updatedAt: number
}

export interface VisibleMessageRecipient {
  address: string
  displayName: string | null
  kind: string
  messageId: string
  position: number
}

export interface MessageReferenceProjection {
  internetMessageId: string
  messageId: string
  position: number
}

export interface MessageAttachmentMetadata {
  contentId: string | null
  disposition: string
  filename: string | null
  id: string
  mediaType: string
  messageId: string
  ordinal: number
  size: number
}

export interface ThreadDetailProjection {
  messages: Array<{
    attachments: Omit<MessageAttachmentMetadata, 'messageId'>[]
    direction: string
    failure: {
      retryability: DeliveryRetryability
      safeErrorCode: string
    } | null
    forwardState: string
    from: ThreadParticipant
    htmlBody: string | null
    htmlPolicy: string
    id: string
    inReplyTo: string | null
    internetMessageId: string | null
    mailboxId: string
    preview: string
    rawAvailable: boolean
    rawSize: number | null
    inbox: boolean
    starredAt: number | null
    trashedAt: number | null
    spamAt: number | null
    spamReason: string | null
    readAt: number | null
    receivedAt: number | null
    recipients: Omit<VisibleMessageRecipient, 'messageId'>[]
    references: string[]
    sendState: string
    sentAt: number
    subject: string
    textBody: string | null
    threadId: string
  }>
  thread: ThreadSummary
}

export interface AuthorizedRawMessage {
  id: string
  mailboxId: string
  rawR2Key: string
  rawSha256: string
  rawSize: number
  threadId: string
}

export interface AuthorizedAttachment {
  contentId: string | null
  displayFilename: string | null
  disposition: string
  id: string
  mailboxId: string
  mediaType: string
  messageId: string
  mimeOrdinal: number
  rawR2Key: string
  rawSha256: string
  rawSize: number
  size: number
}

/**
 * All browser/public-API inbox access is actor-bound at construction time.
 * Every statement below joins or EXISTS-checks mailbox_members; there are no
 * ID-only lookup methods to accidentally authorize after reading private data.
 */
export class MailboxScopedRepository {
  readonly #actorUserId: string
  readonly #binding: D1Database
  readonly #db: InboxDatabase

  constructor(binding: D1Database, actor: AuthenticatedActor) {
    if (actor.userId.length === 0) {
      throw new TypeError('An authenticated user ID is required.')
    }
    this.#actorUserId = actor.userId
    this.#binding = binding
    this.#db = createInboxDatabase(binding)
  }

  async listMailboxes(): Promise<MailboxSummary[]> {
    const countFolder = (folder: ThreadFolder) =>
      sql<number>`coalesce(sum(case when ${sql.raw(folderSql(folder, 'threads'))} then 1 else 0 end), 0)`
    const activeCount = countFolder('all')
    const inboxCount = countFolder('inbox')
    const archiveCount = countFolder('archive')
    const starredCount = countFolder('starred')
    const spamCount = countFolder('spam')
    const trashCount = countFolder('trash')
    const sentCount = countFolder('sent')
    const unreadCount = sql<number>`coalesce(sum((SELECT count(*) FROM messages m WHERE m.thread_id = ${threads.id} AND m.direction = 'inbound' AND m.read_at IS NULL AND m.inbox = 1 AND m.spam_at IS NULL AND m.trashed_at IS NULL)), 0)`

    const rows = await this.#db
      .select({
        activeCount,
        address: mailboxes.address,
        archiveCount,
        createdAt: mailboxes.createdAt,
        forwardTo: mailboxes.forwardTo,
        forwardHtml: mailboxes.forwardHtml,
        renderHtml: mailboxes.renderHtml,
        whitelisted: mailboxes.whitelisted,
        blocked: this.#blockedMailbox(),
        id: mailboxes.id,
        inboxCount,
        starredCount,
        spamCount,
        trashCount,
        role: mailboxMembers.role,
        senderAlias: mailboxes.senderAlias,
        sentCount,
        unreadCount,
        updatedAt: mailboxes.updatedAt,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, mailboxes.id),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .leftJoin(threads, eq(threads.mailboxId, mailboxes.id))
      .groupBy(
        mailboxes.id,
        mailboxes.address,
        mailboxes.senderAlias,
        mailboxes.forwardTo,
        mailboxes.forwardHtml,
        mailboxes.renderHtml,
        mailboxes.whitelisted,
        mailboxes.createdAt,
        mailboxes.updatedAt,
        mailboxMembers.role,
      )
      .orderBy(asc(mailboxes.address), asc(mailboxes.id))

    return rows.map((row) => ({
      ...row,
      activeCount: Number(row.activeCount),
      archiveCount: Number(row.archiveCount),
      inboxCount: Number(row.inboxCount),
      starredCount: Number(row.starredCount),
      spamCount: Number(row.spamCount),
      trashCount: Number(row.trashCount),
      sentCount: Number(row.sentCount),
      unreadCount: Number(row.unreadCount),
    }))
  }

  async listThreads(input: ListThreadsInput = {}): Promise<ThreadPage> {
    const limit = clampThreadPageSize(input.limit)
    const predicates = this.#threadPredicates(input)

    const rows = await this.#db
      .select(threadSummarySelection)
      .from(threads)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, threads.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(and(...predicates))
      .orderBy(desc(threads.lastMessageAt), desc(threads.id))
      .limit(limit + 1)

    return toThreadPage(rows, limit)
  }

  async searchThreads(input: SearchThreadsInput): Promise<ThreadPage> {
    const limit = clampThreadPageSize(input.limit)
    const normalizedQuery = normalizeFtsQuery(input.query)
    const values: (number | string | null)[] = [this.#actorUserId, normalizedQuery]
    const clauses = [
      'mm.user_id = ?',
      'EXISTS (SELECT 1 FROM message_search WHERE message_search.thread_id = t.id AND message_search.mailbox_id = t.mailbox_id AND message_search MATCH ?)',
    ]

    if (input.mailboxId === 'other') {
      clauses.push(
        "EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.id = t.mailbox_id AND (mb.whitelisted = 0 OR EXISTS (SELECT 1 FROM spam_rules sr WHERE sr.user_id = ? AND sr.kind = 'recipient' AND sr.value = mb.address)))",
      )
      values.push(this.#actorUserId)
    } else if (input.mailboxId !== undefined) {
      clauses.push('t.mailbox_id = ?')
      values.push(input.mailboxId)
    }
    appendFolderSql(clauses, input.folder ?? 'all')
    if (input.unreadOnly === true) {
      clauses.push('t.unread_count > 0')
    }
    if (input.cursor !== undefined) {
      const cursor = decodeThreadCursor(input.cursor)
      clauses.push('(t.last_message_at < ? OR (t.last_message_at = ? AND t.id < ?))')
      values.push(cursor.lastMessageAt, cursor.lastMessageAt, cursor.id)
    }

    values.push(limit + 1)
    const statement = this.#binding.prepare(`
      SELECT t.id, t.last_message_at AS lastMessageAt
      FROM threads AS t
      INNER JOIN mailbox_members AS mm ON mm.mailbox_id = t.mailbox_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY t.last_message_at DESC, t.id DESC
      LIMIT ?
    `)
    const result = await statement.bind(...values).all<{ id: string; lastMessageAt: number }>()
    if (result.results.length === 0) {
      return { items: [], nextCursor: null }
    }

    // Hydrate all summaries in one second membership-scoped query. Keeping the
    // FTS statement ID-only avoids duplicating the summary projection in raw SQL.
    const hydrated = await this.#db
      .select(threadSummarySelection)
      .from(threads)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, threads.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(
        inArray(
          threads.id,
          result.results.map(({ id }) => id),
        ),
      )
    const byId = new Map(hydrated.map((row) => [row.id, row]))
    const ordered = result.results.flatMap(({ id }) => {
      const row = byId.get(id)
      return row === undefined ? [] : [row]
    })
    return toThreadPage(ordered, limit)
  }

  async getMailboxSettings(mailboxId: string): Promise<MailboxSettings | undefined> {
    const [row] = await this.#db
      .select({
        address: mailboxes.address,
        forwardTo: mailboxes.forwardTo,
        forwardHtml: mailboxes.forwardHtml,
        renderHtml: mailboxes.renderHtml,
        whitelisted: mailboxes.whitelisted,
        blocked: this.#blockedMailbox(),
        id: mailboxes.id,
        senderAlias: mailboxes.senderAlias,
        updatedAt: mailboxes.updatedAt,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, mailboxes.id),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(mailboxes.id, mailboxId))
      .limit(1)
    return row
  }

  async getThread(threadId: string): Promise<ThreadSummary | undefined> {
    const [row] = await this.#db
      .select(threadSummarySelection)
      .from(threads)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, threads.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(threads.id, threadId))
      .limit(1)
    return row === undefined ? undefined : toThreadSummary(row)
  }

  async listThreadMessages(threadId: string) {
    return this.#db
      .select({
        direction: messages.direction,
        forwardState: messages.forwardState,
        fromAddress: messages.fromAddress,
        fromName: messages.fromName,
        htmlBody: messages.htmlBody,
        htmlPolicy: messages.htmlPolicy,
        id: messages.id,
        inReplyTo: messages.inReplyTo,
        internetMessageId: messages.internetMessageId,
        mailboxId: messages.mailboxId,
        preview: messages.preview,
        inbox: messages.inbox,
        starredAt: messages.starredAt,
        trashedAt: messages.trashedAt,
        spamAt: messages.spamAt,
        spamReason: messages.spamReason,
        readAt: messages.readAt,
        rawAvailable: sql<boolean>`${messages.rawDeletedAt} IS NULL`.mapWith((value) =>
          Boolean(value),
        ),
        rawSize: messages.rawSize,
        receivedAt: messages.receivedAt,
        retryability: messages.retryability,
        safeErrorCode: messages.providerErrorCode,
        sendState: messages.sendState,
        sentAt: messages.sentAt,
        subject: messages.subject,
        textBody: messages.textBody,
        threadId: messages.threadId,
      })
      .from(messages)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.sentAt), asc(messages.id))
  }

  /** Inbound BCC stays hidden; a mailbox's own outbound BCC is part of its sent record. */
  async listVisibleMessageRecipients(messageId: string) {
    return this.#db
      .select({
        address: messageRecipients.address,
        displayName: messageRecipients.displayName,
        kind: messageRecipients.kind,
        messageId: messageRecipients.messageId,
        position: messageRecipients.position,
      })
      .from(messageRecipients)
      .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(
        and(
          eq(messageRecipients.messageId, messageId),
          or(ne(messageRecipients.kind, 'bcc'), eq(messages.direction, 'outbound')),
        ),
      )
      .orderBy(asc(messageRecipients.kind), asc(messageRecipients.position))
  }

  async listThreadVisibleRecipients(threadId: string): Promise<VisibleMessageRecipient[]> {
    return this.#db
      .select({
        address: messageRecipients.address,
        displayName: messageRecipients.displayName,
        kind: messageRecipients.kind,
        messageId: messageRecipients.messageId,
        position: messageRecipients.position,
      })
      .from(messageRecipients)
      .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(
        and(
          eq(messages.threadId, threadId),
          or(ne(messageRecipients.kind, 'bcc'), eq(messages.direction, 'outbound')),
        ),
      )
      .orderBy(
        asc(messages.sentAt),
        asc(messages.id),
        asc(messageRecipients.kind),
        asc(messageRecipients.position),
      )
  }

  async listThreadMessageReferences(threadId: string): Promise<MessageReferenceProjection[]> {
    return this.#db
      .select({
        internetMessageId: messageReferences.internetMessageId,
        messageId: messageReferences.messageId,
        position: messageReferences.position,
      })
      .from(messageReferences)
      .innerJoin(messages, eq(messages.id, messageReferences.messageId))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(messages.threadId, threadId))
      .orderBy(asc(messages.sentAt), asc(messages.id), asc(messageReferences.position))
  }

  async listThreadAttachments(threadId: string): Promise<MessageAttachmentMetadata[]> {
    return this.#db
      .select({
        contentId: attachments.contentId,
        disposition: attachments.disposition,
        filename: attachments.displayFilename,
        id: attachments.id,
        mediaType: attachments.mediaType,
        messageId: attachments.messageId,
        ordinal: attachments.mimeOrdinal,
        size: attachments.size,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(messages.threadId, threadId))
      .orderBy(
        asc(messages.sentAt),
        asc(messages.id),
        asc(attachments.mimeOrdinal),
        asc(attachments.id),
      )
  }

  async getThreadDetail(threadId: string): Promise<ThreadDetailProjection | undefined> {
    const thread = await this.getThread(threadId)
    if (thread === undefined) {
      return undefined
    }
    const [messageRows, recipients, references, attachmentRows] = await Promise.all([
      this.listThreadMessages(threadId),
      this.listThreadVisibleRecipients(threadId),
      this.listThreadMessageReferences(threadId),
      this.listThreadAttachments(threadId),
    ])
    return {
      thread,
      messages: messageRows.map(
        ({ fromAddress, fromName, retryability, safeErrorCode, ...message }) => ({
          ...message,
          attachments: attachmentRows
            .filter((attachment) => attachment.messageId === message.id)
            .map(({ messageId: _messageId, ...attachment }) => attachment),
          from: { address: fromAddress, displayName: fromName },
          failure:
            safeErrorCode === null
              ? null
              : { retryability: retryability as DeliveryRetryability, safeErrorCode },
          recipients: recipients
            .filter((recipient) => recipient.messageId === message.id)
            .map(({ messageId: _messageId, ...recipient }) => recipient),
          references: references
            .filter((reference) => reference.messageId === message.id)
            .map((reference) => reference.internetMessageId),
        }),
      ),
    }
  }

  async listThreadTags(threadId: string) {
    return this.#db
      .select({ id: tags.id, name: tags.name, normalizedName: tags.normalizedName })
      .from(threadTags)
      .innerJoin(tags, and(eq(tags.id, threadTags.tagId), eq(tags.mailboxId, threadTags.mailboxId)))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, threadTags.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(eq(threadTags.threadId, threadId))
      .orderBy(asc(tags.normalizedName), asc(tags.id))
  }

  async getRawMessage(messageId: string): Promise<AuthorizedRawMessage | undefined> {
    const [row] = await this.#db
      .select({
        id: messages.id,
        mailboxId: messages.mailboxId,
        rawR2Key: messages.rawR2Key,
        rawSha256: messages.rawSha256,
        rawSize: messages.rawSize,
        threadId: messages.threadId,
      })
      .from(messages)
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(and(eq(messages.id, messageId), isNull(messages.rawDeletedAt)))
      .limit(1)
    return row
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<AuthorizedAttachment | undefined> {
    const [row] = await this.#db
      .select({
        contentId: attachments.contentId,
        displayFilename: attachments.displayFilename,
        disposition: attachments.disposition,
        id: attachments.id,
        mailboxId: messages.mailboxId,
        mediaType: attachments.mediaType,
        messageId: attachments.messageId,
        mimeOrdinal: attachments.mimeOrdinal,
        rawR2Key: messages.rawR2Key,
        rawSha256: messages.rawSha256,
        rawSize: messages.rawSize,
        size: attachments.size,
      })
      .from(attachments)
      .innerJoin(messages, eq(messages.id, attachments.messageId))
      .innerJoin(
        mailboxMembers,
        and(
          eq(mailboxMembers.mailboxId, messages.mailboxId),
          eq(mailboxMembers.userId, this.#actorUserId),
        ),
      )
      .where(
        and(
          eq(attachments.id, attachmentId),
          eq(attachments.messageId, messageId),
          isNull(messages.rawDeletedAt),
        ),
      )
      .limit(1)
    return row
  }

  async patchMessageState(
    threadId: string,
    patch: MessageStatePatch,
    now: number,
  ): Promise<boolean> {
    assertUnixMilliseconds(now)
    const sets = ['updated_at = max(updated_at, ?)']
    const values: (string | number | null)[] = [now]
    if (patch.read !== undefined) {
      sets.push("read_at = CASE WHEN direction = 'inbound' THEN ? ELSE NULL END")
      values.push(patch.read ? now : null)
    }
    if (patch.starred !== undefined) {
      sets.push('starred_at = ?')
      values.push(patch.starred ? now : null)
    }
    switch (patch.location) {
      case 'archive':
        sets.push('inbox = 0')
        break
      case 'inbox':
        sets.push('inbox = 1', 'trashed_at = NULL', 'spam_at = NULL', 'spam_reason = NULL')
        break
      case 'spam':
        sets.push('spam_at = ?', "spam_reason = 'manual'", 'trashed_at = NULL')
        values.push(now)
        break
      case 'trash':
        sets.push('trashed_at = ?')
        values.push(now)
        break
      case 'restore':
        sets.push('trashed_at = NULL')
        break
      case 'not_spam':
        sets.push('spam_at = NULL', 'spam_reason = NULL', 'inbox = 1')
        break
    }
    if (sets.length === 1) throw new TypeError('Supply a message state change.')
    if (patch.messageIds && (patch.messageIds.length === 0 || patch.messageIds.length > 80))
      throw new TypeError('Invalid message selection.')
    const ids = patch.messageIds ? `AND id IN (${patch.messageIds.map(() => '?').join(',')})` : ''
    const result = await this.#binding.batch([
      this.#binding
        .prepare(`UPDATE messages SET ${sets.join(', ')}
        WHERE thread_id = ? AND EXISTS (SELECT 1 FROM mailbox_members mm WHERE mm.mailbox_id = messages.mailbox_id AND mm.user_id = ?)
        ${ids}`)
        .bind(...values, threadId, this.#actorUserId, ...(patch.messageIds ?? [])),
      this.#binding
        .prepare(`UPDATE threads SET
        message_count = (SELECT count(*) FROM messages m WHERE m.thread_id = threads.id),
        unread_count = (SELECT count(*) FROM messages m WHERE m.thread_id = threads.id AND m.direction = 'inbound' AND m.read_at IS NULL),
        archived_at = CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.inbox = 1 AND m.spam_at IS NULL AND m.trashed_at IS NULL) THEN NULL ELSE coalesce(archived_at, ?) END,
        updated_at = max(updated_at, ?)
        WHERE id = ? AND EXISTS (SELECT 1 FROM mailbox_members mm WHERE mm.mailbox_id = threads.mailbox_id AND mm.user_id = ?)
      `)
        .bind(now, now, threadId, this.#actorUserId),
    ])
    return changed(result[0])
  }

  async markThreadRead(threadId: string, readAt: number): Promise<boolean> {
    assertUnixMilliseconds(readAt)
    const actor = this.#actorUserId
    const statements = [
      this.#binding
        .prepare(`
          UPDATE messages
          SET read_at = ?, updated_at = max(updated_at, ?)
          WHERE thread_id = ? AND direction = 'inbound' AND read_at IS NULL
            AND EXISTS (
              SELECT 1 FROM mailbox_members AS mm
              WHERE mm.mailbox_id = messages.mailbox_id AND mm.user_id = ?
            )
        `)
        .bind(readAt, readAt, threadId, actor),
      this.#binding
        .prepare(`
          UPDATE threads
          SET unread_count = 0, updated_at = max(updated_at, ?)
          WHERE id = ?
            AND EXISTS (
              SELECT 1 FROM mailbox_members AS mm
              WHERE mm.mailbox_id = threads.mailbox_id AND mm.user_id = ?
            )
        `)
        .bind(readAt, threadId, actor),
    ]
    const results = await this.#binding.batch(statements)
    return changed(results[1])
  }

  async setThreadArchived(
    threadId: string,
    archivedAt: number | null,
    now: number,
  ): Promise<boolean> {
    return this.patchMessageState(
      threadId,
      { location: archivedAt === null ? 'inbox' : 'archive' },
      now,
    )
  }

  async setThreadWorkflowState(
    threadId: string,
    workflowState: 'needs_reply' | 'resolved' | 'waiting',
    now: number,
  ): Promise<boolean> {
    assertUnixMilliseconds(now)
    const result = await this.#binding
      .prepare(`
        UPDATE threads
        SET workflow_state = ?, updated_at = max(updated_at, ?)
        WHERE id = ?
          AND EXISTS (
            SELECT 1 FROM mailbox_members AS mm
            WHERE mm.mailbox_id = threads.mailbox_id AND mm.user_id = ?
          )
      `)
      .bind(workflowState, now, threadId, this.#actorUserId)
      .run()
    return changed(result)
  }

  async updateMailboxSettings(
    mailboxId: string,
    values: {
      forwardTo?: string | null
      senderAlias?: string | null
      forwardHtml?: boolean
      renderHtml?: boolean
      whitelisted?: boolean
    },
    now: number,
  ): Promise<boolean> {
    assertUnixMilliseconds(now)
    if (Object.values(values).every((value) => value === undefined)) {
      throw new TypeError('At least one mailbox setting must be supplied.')
    }
    const result = await this.#binding
      .prepare(`
        UPDATE mailboxes
        SET
          whitelisted = CASE WHEN ? = 1 THEN ? ELSE whitelisted END,
          forward_to = CASE WHEN ? = 1 THEN ? ELSE forward_to END,
          sender_alias = CASE WHEN ? = 1 THEN ? ELSE sender_alias END,
          forward_html = CASE WHEN ? = 1 THEN ? ELSE forward_html END,
          render_html = CASE WHEN ? = 1 THEN ? ELSE render_html END,
          updated_at = max(updated_at, ?)
        WHERE id = ?
          AND EXISTS (
            SELECT 1 FROM mailbox_members AS mm
            WHERE mm.mailbox_id = mailboxes.id
              AND mm.user_id = ?
              AND mm.role = 'owner'
          )
      `)
      .bind(
        values.whitelisted === undefined ? 0 : 1,
        values.whitelisted ? 1 : 0,
        values.forwardTo === undefined ? 0 : 1,
        values.forwardTo ?? null,
        values.senderAlias === undefined ? 0 : 1,
        values.senderAlias ?? null,
        values.forwardHtml === undefined ? 0 : 1,
        values.forwardHtml ? 1 : 0,
        values.renderHtml === undefined ? 0 : 1,
        values.renderHtml ? 1 : 0,
        now,
        mailboxId,
        this.#actorUserId,
      )
      .run()
    return changed(result)
  }

  #blockedMailbox(): SQL<boolean> {
    return sql<boolean>`EXISTS (SELECT 1 FROM spam_rules sr WHERE sr.user_id = ${this.#actorUserId} AND sr.kind = 'recipient' AND sr.value = ${mailboxes.address})`.mapWith(
      Boolean,
    )
  }

  #threadPredicates(input: ListThreadsInput): SQL[] {
    const predicates: SQL[] = []
    if (input.mailboxId === 'other') {
      predicates.push(
        sql`EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.id = ${threads.mailboxId} AND (mb.whitelisted = 0 OR EXISTS (SELECT 1 FROM spam_rules sr WHERE sr.user_id = ${this.#actorUserId} AND sr.kind = 'recipient' AND sr.value = mb.address)))`,
      )
    } else if (input.mailboxId !== undefined) {
      predicates.push(eq(threads.mailboxId, input.mailboxId))
    }

    predicates.push(sql.raw(folderSql(input.folder ?? 'inbox', 'threads')))

    if (input.unreadOnly === true) {
      predicates.push(gt(threads.unreadCount, 0))
    }
    if (input.cursor !== undefined) {
      const cursor = decodeThreadCursor(input.cursor)
      const afterCursor = or(
        lt(threads.lastMessageAt, cursor.lastMessageAt),
        and(eq(threads.lastMessageAt, cursor.lastMessageAt), lt(threads.id, cursor.id)),
      )
      if (afterCursor !== undefined) {
        predicates.push(afterCursor)
      }
    }
    return predicates
  }
}

const attachmentCountProjection = sql<number>`(
  SELECT count(*)
  FROM attachments AS summary_attachment
  INNER JOIN messages AS summary_attachment_message
    ON summary_attachment_message.id = summary_attachment.message_id
  WHERE summary_attachment_message.thread_id = ${threads.id}
    AND summary_attachment_message.mailbox_id = ${threads.mailboxId}
)`

const participantsJsonProjection = sql<string>`coalesce((
  SELECT json_group_array(
    json_object('address', participant.address, 'displayName', participant.display_name)
  )
  FROM (
    SELECT address, max(display_name) AS display_name
    FROM (
      SELECT
        summary_message.from_address AS address,
        summary_message.from_name AS display_name
      FROM messages AS summary_message
      WHERE summary_message.thread_id = ${threads.id}
        AND summary_message.mailbox_id = ${threads.mailboxId}
      UNION ALL
      SELECT summary_recipient.address, summary_recipient.display_name
      FROM messages AS summary_recipient_message
      INNER JOIN message_recipients AS summary_recipient
        ON summary_recipient.message_id = summary_recipient_message.id
      WHERE summary_recipient_message.thread_id = ${threads.id}
        AND summary_recipient_message.mailbox_id = ${threads.mailboxId}
        AND summary_recipient.kind <> 'bcc'
    )
    GROUP BY address
    ORDER BY address
  ) AS participant
), '[]')`

const tagsJsonProjection = sql<string>`coalesce((
  SELECT json_group_array(json_object('name', tag_summary.name))
  FROM (
    SELECT summary_tag.name
    FROM thread_tags AS summary_thread_tag
    INNER JOIN tags AS summary_tag
      ON summary_tag.id = summary_thread_tag.tag_id
      AND summary_tag.mailbox_id = summary_thread_tag.mailbox_id
    WHERE summary_thread_tag.thread_id = ${threads.id}
      AND summary_thread_tag.mailbox_id = ${threads.mailboxId}
    ORDER BY summary_tag.normalized_name, summary_tag.id
  ) AS tag_summary
), '[]')`

const threadSummarySelection = {
  hasInbox: sql<boolean>`${sql.raw(folderSql('inbox', 'threads'))}`.mapWith(Boolean),
  hasSent: sql<boolean>`${sql.raw(folderSql('sent', 'threads'))}`.mapWith(Boolean),
  hasStarred: sql<boolean>`${sql.raw(folderSql('starred', 'threads'))}`.mapWith(Boolean),
  hasSpam: sql<boolean>`${sql.raw(folderSql('spam', 'threads'))}`.mapWith(Boolean),
  hasTrash: sql<boolean>`${sql.raw(folderSql('trash', 'threads'))}`.mapWith(Boolean),
  hasNormal: sql<boolean>`${sql.raw(folderSql('all', 'threads'))}`.mapWith(Boolean),
  archivedAt: threads.archivedAt,
  attachmentCount: attachmentCountProjection,
  id: threads.id,
  lastMessageAt: threads.lastMessageAt,
  lastMessageDirection: threads.lastMessageDirection,
  lastMessagePreview: threads.lastMessagePreview,
  lastSenderAddress: threads.lastSenderAddress,
  mailboxId: threads.mailboxId,
  messageCount: threads.messageCount,
  normalizedSubject: threads.normalizedSubject,
  participantsJson: participantsJsonProjection,
  subject: threads.subject,
  tagsJson: tagsJsonProjection,
  unreadCount: threads.unreadCount,
  workflowState: threads.workflowState,
}

interface ThreadSummaryRow extends Omit<ThreadSummary, 'participants' | 'tags'> {
  participantsJson: string
  tagsJson: string
}

function toThreadPage(rows: ThreadSummaryRow[], limit: number): ThreadPage {
  const items = rows.slice(0, limit).map(toThreadSummary)
  const lastItem = items.at(-1)
  return {
    items,
    nextCursor:
      rows.length > limit && lastItem !== undefined
        ? encodeThreadCursor({ id: lastItem.id, lastMessageAt: lastItem.lastMessageAt })
        : null,
  }
}

function toThreadSummary(row: ThreadSummaryRow): ThreadSummary {
  const { participantsJson, tagsJson, ...summary } = row
  return {
    ...summary,
    attachmentCount: Number(summary.attachmentCount),
    participants: parseThreadParticipants(participantsJson),
    tags: parseThreadTags(tagsJson),
  }
}

function parseThreadParticipants(value: string): ThreadParticipant[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid participant projection returned by D1.')
  }
  return parsed.map((participant) => {
    if (
      typeof participant !== 'object' ||
      participant === null ||
      !('address' in participant) ||
      typeof participant.address !== 'string' ||
      !('displayName' in participant) ||
      (participant.displayName !== null && typeof participant.displayName !== 'string')
    ) {
      throw new Error('Invalid participant projection returned by D1.')
    }
    return { address: participant.address, displayName: participant.displayName }
  })
}

function parseThreadTags(value: string): ThreadTagSummary[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) {
    throw new Error('Invalid tag projection returned by D1.')
  }
  return parsed.map((tag) => {
    if (
      typeof tag !== 'object' ||
      tag === null ||
      !('name' in tag) ||
      typeof tag.name !== 'string'
    ) {
      throw new Error('Invalid tag projection returned by D1.')
    }
    return { name: tag.name }
  })
}

function folderSql(folder: ThreadFolder, table: 't' | 'threads'): string {
  const normal = 'm.spam_at IS NULL AND m.trashed_at IS NULL'
  const condition = {
    inbox: `${normal} AND m.inbox = 1`,
    all: normal,
    archive: `${normal} AND m.inbox = 0`,
    sent: `${normal} AND m.direction = 'outbound' AND m.send_state = 'sent'`,
    starred: `${normal} AND m.starred_at IS NOT NULL`,
    spam: 'm.spam_at IS NOT NULL AND m.trashed_at IS NULL',
    trash: 'm.trashed_at IS NOT NULL',
  }[folder]
  const matches = `EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = ${table}.id AND m.mailbox_id = ${table}.mailbox_id AND ${condition})`
  return folder === 'archive' ? `${matches} AND NOT (${folderSql('inbox', table)})` : matches
}

function appendFolderSql(clauses: string[], folder: ThreadFolder): void {
  clauses.push(folderSql(folder, 't'))
}

/** Turns user text into bounded literal-prefix FTS terms, never FTS operators. */
export function normalizeFtsQuery(input: string): string {
  const terms = input
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}][\p{L}\p{N}@._+-]{0,63}/gu)
    ?.slice(0, 12)
  if (terms === undefined || terms.length === 0) {
    throw new TypeError('Search must contain at least one letter or number.')
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(' AND ')
}

function assertUnixMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Timestamp must be a non-negative Unix millisecond integer.')
  }
}

function changed(result: D1Result<unknown> | undefined): boolean {
  return (result?.meta.changes ?? 0) > 0
}
