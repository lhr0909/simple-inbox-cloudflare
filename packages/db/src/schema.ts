import { desc, sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * D1 persistence uses Unix epoch milliseconds everywhere. API boundaries are
 * responsible for converting these values to and from ISO-8601 strings.
 */
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().notNull(),
    email: text('email').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    disabledAt: integer('disabled_at', { mode: 'number' }),
  },
  (table) => ({
    emailNormalized: check(
      'users_email_normalized_check',
      sql`${table.email} = lower(trim(${table.email})) AND length(${table.email}) BETWEEN 3 AND 320`,
    ),
    emailUnique: uniqueIndex('users_email_uidx').on(table.email),
    timestamps: check(
      'users_timestamps_check',
      sql`${table.createdAt} >= 0 AND (${table.disabledAt} IS NULL OR ${table.disabledAt} >= ${table.createdAt})`,
    ),
  }),
)

export const mailboxes = sqliteTable(
  'mailboxes',
  {
    id: text('id').primaryKey().notNull(),
    address: text('address').notNull(),
    senderAlias: text('sender_alias'),
    forwardTo: text('forward_to'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    addressNormalized: check(
      'mailboxes_address_normalized_check',
      sql`${table.address} = lower(trim(${table.address})) AND length(${table.address}) BETWEEN 3 AND 320`,
    ),
    addressUnique: uniqueIndex('mailboxes_address_uidx').on(table.address),
    forwardToNormalized: check(
      'mailboxes_forward_to_normalized_check',
      sql`${table.forwardTo} IS NULL OR (${table.forwardTo} = lower(trim(${table.forwardTo})) AND length(${table.forwardTo}) BETWEEN 3 AND 320)`,
    ),
    senderAliasLength: check(
      'mailboxes_sender_alias_length_check',
      sql`${table.senderAlias} IS NULL OR length(${table.senderAlias}) BETWEEN 1 AND 200`,
    ),
    timestamps: check(
      'mailboxes_timestamps_check',
      sql`${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  }),
)

export const mailboxMembers = sqliteTable(
  'mailbox_members',
  {
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    role: text('role').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    primaryKey: primaryKey({
      columns: [table.mailboxId, table.userId],
      name: 'mailbox_members_pk',
    }),
    role: check('mailbox_members_role_check', sql`${table.role} IN ('owner', 'member')`),
    timestamp: check('mailbox_members_created_at_check', sql`${table.createdAt} >= 0`),
    userLookup: index('mailbox_members_user_idx').on(table.userId, table.mailboxId),
  }),
)

export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    tokenDigest: text('token_digest').notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    usedAt: integer('used_at', { mode: 'number' }),
    requestedAt: integer('requested_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    digest: check(
      'magic_links_digest_check',
      sql`length(${table.tokenDigest}) = 64 AND ${table.tokenDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    digestUnique: uniqueIndex('magic_links_token_digest_uidx').on(table.tokenDigest),
    expiryLookup: index('magic_links_digest_expiry_idx').on(
      table.tokenDigest,
      table.expiresAt,
      table.usedAt,
    ),
    timestamps: check(
      'magic_links_timestamps_check',
      sql`${table.requestedAt} >= 0 AND ${table.expiresAt} > ${table.requestedAt} AND (${table.usedAt} IS NULL OR ${table.usedAt} >= ${table.requestedAt})`,
    ),
    userCooldown: index('magic_links_user_requested_idx').on(table.userId, desc(table.requestedAt)),
  }),
)

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    tokenDigest: text('token_digest').notNull(),
    sourceMagicLinkId: text('source_magic_link_id')
      .notNull()
      .references(() => magicLinks.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    lastSeenAt: integer('last_seen_at', { mode: 'number' }).notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    digest: check(
      'sessions_digest_check',
      sql`length(${table.tokenDigest}) = 64 AND ${table.tokenDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    digestUnique: uniqueIndex('sessions_token_digest_uidx').on(table.tokenDigest),
    sourceMagicLinkUnique: uniqueIndex('sessions_source_magic_link_uidx').on(
      table.sourceMagicLinkId,
    ),
    tokenExpiry: index('sessions_token_expiry_idx').on(
      table.tokenDigest,
      table.expiresAt,
      table.revokedAt,
    ),
    timestamps: check(
      'sessions_timestamps_check',
      sql`${table.createdAt} >= 0 AND ${table.lastSeenAt} >= ${table.createdAt} AND ${table.expiresAt} > ${table.createdAt} AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`,
    ),
    userActive: index('sessions_user_active_idx').on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
  }),
)

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    tokenDigest: text('token_digest').notNull(),
    name: text('name').notNull(),
    scopes: integer('scopes', { mode: 'number' }).notNull(),
    expiresAt: integer('expires_at', { mode: 'number' }),
    revokedAt: integer('revoked_at', { mode: 'number' }),
    lastUsedAt: integer('last_used_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    digest: check(
      'api_tokens_digest_check',
      sql`length(${table.tokenDigest}) = 64 AND ${table.tokenDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    digestUnique: uniqueIndex('api_tokens_token_digest_uidx').on(table.tokenDigest),
    nameLength: check(
      'api_tokens_name_length_check',
      sql`length(trim(${table.name})) BETWEEN 1 AND 100`,
    ),
    scopes: check('api_tokens_scopes_check', sql`${table.scopes} BETWEEN 1 AND 7`),
    tokenExpiry: index('api_tokens_token_expiry_idx').on(
      table.tokenDigest,
      table.expiresAt,
      table.revokedAt,
    ),
    timestamps: check(
      'api_tokens_timestamps_check',
      sql`${table.createdAt} >= 0 AND (${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}) AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}) AND (${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt})`,
    ),
    userActive: index('api_tokens_user_active_idx').on(
      table.userId,
      table.revokedAt,
      table.expiresAt,
    ),
  }),
)

export const threads = sqliteTable(
  'threads',
  {
    id: text('id').primaryKey().notNull(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    subject: text('subject').notNull(),
    normalizedSubject: text('normalized_subject').notNull(),
    workflowState: text('workflow_state').notNull(),
    archivedAt: integer('archived_at', { mode: 'number' }),
    latestMessageId: text('latest_message_id').references((): AnySQLiteColumn => messages.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    lastMessageAt: integer('last_message_at', { mode: 'number' }).notNull(),
    lastMessagePreview: text('last_message_preview').notNull(),
    lastMessageDirection: text('last_message_direction'),
    lastSenderAddress: text('last_sender_address'),
    messageCount: integer('message_count', { mode: 'number' }).notNull().default(0),
    unreadCount: integer('unread_count', { mode: 'number' }).notNull().default(0),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    aggregateCounts: check(
      'threads_aggregate_counts_check',
      sql`${table.messageCount} >= 0 AND ${table.unreadCount} >= 0 AND ${table.unreadCount} <= ${table.messageCount}`,
    ),
    archiveTimestamp: check(
      'threads_archive_timestamp_check',
      sql`${table.archivedAt} IS NULL OR ${table.archivedAt} >= ${table.createdAt}`,
    ),
    direction: check(
      'threads_last_direction_check',
      sql`${table.lastMessageDirection} IS NULL OR ${table.lastMessageDirection} IN ('inbound', 'outbound')`,
    ),
    mailboxArchiveOrder: index('threads_mailbox_archive_order_idx').on(
      table.mailboxId,
      table.archivedAt,
      desc(table.lastMessageAt),
      desc(table.id),
    ),
    mailboxIdentity: uniqueIndex('threads_id_mailbox_uidx').on(table.id, table.mailboxId),
    mailboxUnreadOrder: index('threads_mailbox_unread_order_idx').on(
      table.mailboxId,
      table.unreadCount,
      table.archivedAt,
      desc(table.lastMessageAt),
      desc(table.id),
    ),
    mailboxWorkflowOrder: index('threads_mailbox_workflow_archive_order_idx').on(
      table.mailboxId,
      table.workflowState,
      table.archivedAt,
      desc(table.lastMessageAt),
      desc(table.id),
    ),
    normalizedSender: check(
      'threads_last_sender_normalized_check',
      sql`${table.lastSenderAddress} IS NULL OR ${table.lastSenderAddress} = lower(trim(${table.lastSenderAddress}))`,
    ),
    timestamps: check(
      'threads_timestamps_check',
      sql`${table.createdAt} >= 0 AND ${table.lastMessageAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
    workflowState: check(
      'threads_workflow_state_check',
      sql`${table.workflowState} IN ('needs_reply', 'waiting', 'resolved')`,
    ),
  }),
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey().notNull(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    threadId: text('thread_id').notNull(),
    direction: text('direction').notNull(),
    ingestDigest: text('ingest_digest'),
    internetMessageId: text('internet_message_id'),
    providerMessageId: text('provider_message_id'),
    inReplyTo: text('in_reply_to'),
    fromAddress: text('from_address').notNull(),
    fromName: text('from_name'),
    subject: text('subject').notNull(),
    preview: text('preview').notNull(),
    textBody: text('text_body'),
    htmlBody: text('html_body'),
    htmlPolicy: text('html_policy').notNull(),
    sentAt: integer('sent_at', { mode: 'number' }).notNull(),
    receivedAt: integer('received_at', { mode: 'number' }),
    rawR2Key: text('raw_r2_key').notNull(),
    rawSize: integer('raw_size', { mode: 'number' }).notNull(),
    rawSha256: text('raw_sha256').notNull(),
    rawDeletedAt: integer('raw_deleted_at', { mode: 'number' }),
    readAt: integer('read_at', { mode: 'number' }),
    sendState: text('send_state').notNull(),
    forwardState: text('forward_state').notNull(),
    providerErrorCode: text('provider_error_code'),
    retryability: text('retryability').notNull(),
    sendAttemptedAt: integer('send_attempted_at', { mode: 'number' }),
    forwardAttemptedAt: integer('forward_attempted_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    direction: check(
      'messages_direction_check',
      sql`${table.direction} IN ('inbound', 'outbound')`,
    ),
    directionStates: check(
      'messages_direction_states_check',
      sql`(${table.direction} = 'inbound' AND ${table.sendState} = 'not_applicable' AND ${table.forwardState} IN ('not_applicable', 'pending', 'forwarded', 'failed', 'unknown')) OR (${table.direction} = 'outbound' AND ${table.sendState} IN ('queued', 'sending', 'sent', 'failed', 'unknown') AND ${table.forwardState} = 'not_applicable')`,
    ),
    errorCode: check(
      'messages_provider_error_code_check',
      sql`${table.providerErrorCode} IS NULL OR (length(${table.providerErrorCode}) BETWEEN 1 AND 128 AND instr(${table.providerErrorCode}, char(10)) = 0 AND instr(${table.providerErrorCode}, char(13)) = 0)`,
    ),
    failureState: check(
      'messages_failure_state_check',
      sql`(${table.providerErrorCode} IS NOT NULL AND (${table.forwardState} IN ('failed', 'unknown') OR ${table.sendState} IN ('failed', 'unknown'))) OR (${table.providerErrorCode} IS NULL AND ${table.forwardState} NOT IN ('failed', 'unknown') AND ${table.sendState} NOT IN ('failed', 'unknown'))`,
    ),
    htmlPolicy: check(
      'messages_html_policy_check',
      sql`(${table.htmlBody} IS NULL AND ${table.htmlPolicy} IN ('none', 'blocked')) OR (${table.htmlBody} IS NOT NULL AND ${table.htmlPolicy} = 'sanitized')`,
    ),
    inboundDigest: check(
      'messages_ingest_digest_check',
      sql`(${table.direction} = 'inbound' AND length(${table.ingestDigest}) = 64 AND ${table.ingestDigest} NOT GLOB '*[^0-9a-f]*') OR (${table.direction} = 'outbound' AND ${table.ingestDigest} IS NULL)`,
    ),
    inboundDigestUnique: uniqueIndex('messages_inbound_ingest_digest_uidx')
      .on(table.ingestDigest)
      .where(sql`${table.direction} = 'inbound'`),
    internetMessageUnique: uniqueIndex('messages_mailbox_internet_message_uidx')
      .on(table.mailboxId, table.internetMessageId)
      .where(sql`${table.internetMessageId} IS NOT NULL`),
    mailboxIdentity: uniqueIndex('messages_id_mailbox_uidx').on(table.id, table.mailboxId),
    mailboxThread: foreignKey({
      columns: [table.threadId, table.mailboxId],
      foreignColumns: [threads.id, threads.mailboxId],
      name: 'messages_thread_mailbox_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    mailboxThreadLookup: index('messages_mailbox_thread_idx').on(table.mailboxId, table.threadId),
    normalizedFrom: check(
      'messages_from_address_normalized_check',
      sql`${table.fromAddress} = lower(trim(${table.fromAddress})) AND length(${table.fromAddress}) BETWEEN 3 AND 320`,
    ),
    rawMetadata: check(
      'messages_raw_metadata_check',
      sql`length(${table.rawR2Key}) BETWEEN 1 AND 1024 AND ${table.rawSize} >= 0 AND length(${table.rawSha256}) = 64 AND ${table.rawSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    rawRetention: check(
      'messages_raw_deleted_at_check',
      sql`${table.rawDeletedAt} IS NULL OR ${table.rawDeletedAt} >= ${table.createdAt}`,
    ),
    readState: check(
      'messages_read_state_check',
      sql`${table.direction} = 'inbound' OR ${table.readAt} IS NULL`,
    ),
    retryability: check(
      'messages_retryability_check',
      sql`(${table.direction} = 'inbound' AND ((${table.forwardState} = 'pending' AND ${table.retryability} = 'retryable') OR (${table.forwardState} = 'unknown' AND ${table.retryability} = 'manual_confirmation_required') OR (${table.forwardState} IN ('not_applicable', 'forwarded', 'failed') AND ${table.retryability} = 'not_retryable'))) OR (${table.direction} = 'outbound' AND ((${table.sendState} = 'queued' AND ${table.retryability} = 'retryable') OR (${table.sendState} IN ('sending', 'unknown') AND ${table.retryability} = 'manual_confirmation_required') OR (${table.sendState} IN ('sent', 'failed') AND ${table.retryability} = 'not_retryable')))`,
    ),
    receivedState: check(
      'messages_received_state_check',
      sql`${table.direction} = 'outbound' OR ${table.receivedAt} IS NOT NULL`,
    ),
    threadChronology: index('messages_thread_sent_idx').on(table.threadId, table.sentAt, table.id),
    timestamps: check(
      'messages_timestamps_check',
      sql`${table.createdAt} >= 0 AND ${table.sentAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND (${table.receivedAt} IS NULL OR ${table.receivedAt} >= 0) AND (${table.readAt} IS NULL OR ${table.readAt} >= 0) AND (${table.sendAttemptedAt} IS NULL OR ${table.sendAttemptedAt} >= 0) AND (${table.forwardAttemptedAt} IS NULL OR ${table.forwardAttemptedAt} >= 0)`,
    ),
  }),
)

export const messageRecipients = sqliteTable(
  'message_recipients',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    kind: text('kind').notNull(),
    position: integer('position', { mode: 'number' }).notNull(),
    address: text('address').notNull(),
    displayName: text('display_name'),
  },
  (table) => ({
    addressLookup: index('message_recipients_address_idx').on(table.address, table.messageId),
    addressNormalized: check(
      'message_recipients_address_normalized_check',
      sql`${table.address} = lower(trim(${table.address})) AND length(${table.address}) BETWEEN 3 AND 320`,
    ),
    kind: check(
      'message_recipients_kind_check',
      sql`${table.kind} IN ('to', 'cc', 'bcc', 'reply_to')`,
    ),
    position: check('message_recipients_position_check', sql`${table.position} >= 0`),
    primaryKey: primaryKey({
      columns: [table.messageId, table.kind, table.position],
      name: 'message_recipients_pk',
    }),
    uniqueAddressPerKind: uniqueIndex('message_recipients_message_kind_address_uidx').on(
      table.messageId,
      table.kind,
      table.address,
    ),
  }),
)

export const messageReferences = sqliteTable(
  'message_references',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    position: integer('position', { mode: 'number' }).notNull(),
    internetMessageId: text('internet_message_id').notNull(),
  },
  (table) => ({
    position: check('message_references_position_check', sql`${table.position} >= 0`),
    primaryKey: primaryKey({
      columns: [table.messageId, table.position],
      name: 'message_references_pk',
    }),
    uniqueReference: uniqueIndex('message_references_message_reference_uidx').on(
      table.messageId,
      table.internetMessageId,
    ),
  }),
)

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    mimeOrdinal: integer('mime_ordinal', { mode: 'number' }).notNull(),
    displayFilename: text('display_filename'),
    mediaType: text('media_type').notNull(),
    size: integer('size', { mode: 'number' }).notNull(),
    disposition: text('disposition').notNull(),
    contentId: text('content_id'),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    disposition: check(
      'attachments_disposition_check',
      sql`${table.disposition} IN ('attachment', 'inline', 'unknown')`,
    ),
    mediaTypeNormalized: check(
      'attachments_media_type_normalized_check',
      sql`${table.mediaType} = lower(trim(${table.mediaType})) AND instr(${table.mediaType}, '/') > 1`,
    ),
    messageLookup: index('attachments_message_idx').on(table.messageId, table.mimeOrdinal),
    messageOrdinalUnique: uniqueIndex('attachments_message_ordinal_uidx').on(
      table.messageId,
      table.mimeOrdinal,
    ),
    values: check(
      'attachments_values_check',
      sql`${table.mimeOrdinal} >= 0 AND ${table.size} >= 0 AND ${table.createdAt} >= 0 AND (${table.displayFilename} IS NULL OR length(${table.displayFilename}) BETWEEN 1 AND 255)`,
    ),
  }),
)

export const replyAliases = sqliteTable(
  'reply_aliases',
  {
    id: text('id').primaryKey().notNull(),
    localPart: text('local_part').notNull(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    threadId: text('thread_id').notNull(),
    targetMessageId: text('target_message_id').references(() => messages.id, {
      onDelete: 'set null',
      onUpdate: 'cascade',
    }),
    relayDestination: text('relay_destination').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'number' }),
  },
  (table) => ({
    localPart: check(
      'reply_aliases_local_part_check',
      sql`${table.localPart} = lower(trim(${table.localPart})) AND length(${table.localPart}) BETWEEN 16 AND 128 AND ${table.localPart} NOT GLOB '*[^a-z0-9_-]*'`,
    ),
    localPartUnique: uniqueIndex('reply_aliases_local_part_uidx').on(table.localPart),
    messageDestinationUnique: uniqueIndex('reply_aliases_message_destination_uidx')
      .on(table.mailboxId, table.targetMessageId, table.relayDestination)
      .where(sql`${table.targetMessageId} IS NOT NULL`),
    mailboxThread: foreignKey({
      columns: [table.threadId, table.mailboxId],
      foreignColumns: [threads.id, threads.mailboxId],
      name: 'reply_aliases_thread_mailbox_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    relayDestinationNormalized: check(
      'reply_aliases_relay_destination_normalized_check',
      sql`${table.relayDestination} = lower(trim(${table.relayDestination})) AND length(${table.relayDestination}) BETWEEN 3 AND 320`,
    ),
    threadLookup: index('reply_aliases_thread_idx').on(
      table.mailboxId,
      table.threadId,
      table.revokedAt,
    ),
    timestamps: check(
      'reply_aliases_timestamps_check',
      sql`${table.createdAt} >= 0 AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`,
    ),
  }),
)

export const tags = sqliteTable(
  'tags',
  {
    id: text('id').primaryKey().notNull(),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    mailboxIdentity: uniqueIndex('tags_id_mailbox_uidx').on(table.id, table.mailboxId),
    mailboxNameUnique: uniqueIndex('tags_mailbox_name_uidx').on(
      table.mailboxId,
      table.normalizedName,
    ),
    normalizedName: check(
      'tags_normalized_name_check',
      sql`${table.normalizedName} = lower(trim(${table.normalizedName})) AND length(${table.normalizedName}) BETWEEN 1 AND 100 AND length(trim(${table.name})) BETWEEN 1 AND 100`,
    ),
    timestamp: check('tags_created_at_check', sql`${table.createdAt} >= 0`),
  }),
)

export const threadTags = sqliteTable(
  'thread_tags',
  {
    threadId: text('thread_id').notNull(),
    tagId: text('tag_id').notNull(),
    mailboxId: text('mailbox_id').notNull(),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    mailboxTag: foreignKey({
      columns: [table.tagId, table.mailboxId],
      foreignColumns: [tags.id, tags.mailboxId],
      name: 'thread_tags_tag_mailbox_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    mailboxThread: foreignKey({
      columns: [table.threadId, table.mailboxId],
      foreignColumns: [threads.id, threads.mailboxId],
      name: 'thread_tags_thread_mailbox_fk',
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    primaryKey: primaryKey({ columns: [table.threadId, table.tagId], name: 'thread_tags_pk' }),
    tagLookup: index('thread_tags_tag_idx').on(table.tagId, table.threadId),
    timestamp: check('thread_tags_created_at_check', sql`${table.createdAt} >= 0`),
  }),
)

export const outboundSends = sqliteTable(
  'outbound_sends',
  {
    id: text('id').primaryKey().notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    actorUserId: text('actor_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict', onUpdate: 'cascade' }),
    mailboxId: text('mailbox_id')
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
    threadId: text('thread_id'),
    requestDigest: text('request_digest').notNull(),
    state: text('state').notNull(),
    messageId: text('message_id'),
    providerMessageId: text('provider_message_id'),
    providerErrorCode: text('provider_error_code'),
    retryability: text('retryability').notNull(),
    attemptCount: integer('attempt_count', { mode: 'number' }).notNull().default(0),
    lastAttemptedAt: integer('last_attempted_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  },
  (table) => ({
    idempotencyKey: check(
      'outbound_sends_idempotency_key_check',
      sql`length(${table.idempotencyKey}) BETWEEN 16 AND 256`,
    ),
    idempotencyKeyUnique: uniqueIndex('outbound_sends_idempotency_key_uidx').on(
      table.idempotencyKey,
    ),
    mailboxMessage: foreignKey({
      columns: [table.messageId, table.mailboxId],
      foreignColumns: [messages.id, messages.mailboxId],
      name: 'outbound_sends_message_mailbox_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    mailboxState: index('outbound_sends_mailbox_state_idx').on(
      table.mailboxId,
      table.state,
      table.updatedAt,
    ),
    mailboxThread: foreignKey({
      columns: [table.threadId, table.mailboxId],
      foreignColumns: [threads.id, threads.mailboxId],
      name: 'outbound_sends_thread_mailbox_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    requestDigest: check(
      'outbound_sends_request_digest_check',
      sql`length(${table.requestDigest}) = 64 AND ${table.requestDigest} NOT GLOB '*[^0-9a-f]*'`,
    ),
    failureState: check(
      'outbound_sends_failure_state_check',
      sql`(${table.providerErrorCode} IS NOT NULL AND ${table.state} IN ('failed', 'unknown')) OR (${table.providerErrorCode} IS NULL AND ${table.state} NOT IN ('failed', 'unknown'))`,
    ),
    retryability: check(
      'outbound_sends_retryability_check',
      sql`(${table.state} = 'queued' AND ${table.retryability} = 'retryable') OR (${table.state} IN ('sending', 'unknown') AND ${table.retryability} = 'manual_confirmation_required') OR (${table.state} IN ('sent', 'failed') AND ${table.retryability} = 'not_retryable')`,
    ),
    state: check(
      'outbound_sends_state_check',
      sql`${table.state} IN ('queued', 'sending', 'sent', 'failed', 'unknown')`,
    ),
    timestamps: check(
      'outbound_sends_timestamps_check',
      sql`${table.attemptCount} >= 0 AND ${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND (${table.lastAttemptedAt} IS NULL OR ${table.lastAttemptedAt} >= ${table.createdAt})`,
    ),
  }),
)

/**
 * Durable retention workflow records intentionally do not reference messages,
 * threads, or mailboxes with foreign keys: a completed tombstone must survive
 * application-record deletion as minimal operational evidence. It contains no
 * message body, address, subject, recipient, or attachment metadata.
 *
 * Policy is snapshotted when a message becomes raw-retention eligible. The
 * application deadline must be at or after the raw deadline so R2 deletion can
 * always happen before normalized D1 deletion.
 */
export const retentionTombstones = sqliteTable(
  'retention_tombstones',
  {
    id: text('id').primaryKey().notNull(),
    messageId: text('message_id').notNull(),
    mailboxId: text('mailbox_id').notNull(),
    threadId: text('thread_id').notNull(),
    rawR2Key: text('raw_r2_key').notNull(),
    messageCreatedAt: integer('message_created_at', { mode: 'number' }).notNull(),
    rawDeleteAfter: integer('raw_delete_after', { mode: 'number' }).notNull(),
    applicationDeleteAfter: integer('application_delete_after', { mode: 'number' }).notNull(),
    state: text('state').notNull(),
    attemptCount: integer('attempt_count', { mode: 'number' }).notNull().default(0),
    claimToken: text('claim_token'),
    claimedAt: integer('claimed_at', { mode: 'number' }),
    claimExpiresAt: integer('claim_expires_at', { mode: 'number' }),
    rawDeletedAt: integer('raw_deleted_at', { mode: 'number' }),
    applicationDeletedAt: integer('application_deleted_at', { mode: 'number' }),
    lastErrorCode: text('last_error_code'),
    lastFailedAt: integer('last_failed_at', { mode: 'number' }),
    createdAt: integer('created_at', { mode: 'number' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
    completedAt: integer('completed_at', { mode: 'number' }),
  },
  (table) => ({
    claim: check(
      'retention_tombstones_claim_check',
      sql`(${table.claimToken} IS NULL AND ${table.claimedAt} IS NULL AND ${table.claimExpiresAt} IS NULL) OR (${table.claimToken} IS NOT NULL AND length(${table.claimToken}) BETWEEN 16 AND 128 AND instr(${table.claimToken}, char(10)) = 0 AND instr(${table.claimToken}, char(13)) = 0 AND ${table.claimedAt} IS NOT NULL AND ${table.claimExpiresAt} > ${table.claimedAt})`,
    ),
    error: check(
      'retention_tombstones_error_check',
      sql`(${table.lastErrorCode} IS NULL AND ${table.lastFailedAt} IS NULL) OR (${table.lastErrorCode} IS NOT NULL AND length(${table.lastErrorCode}) BETWEEN 1 AND 128 AND instr(${table.lastErrorCode}, char(10)) = 0 AND instr(${table.lastErrorCode}, char(13)) = 0 AND ${table.lastFailedAt} IS NOT NULL)`,
    ),
    messageUnique: uniqueIndex('retention_tombstones_message_uidx').on(table.messageId),
    rawKey: check(
      'retention_tombstones_raw_key_check',
      sql`length(${table.rawR2Key}) BETWEEN 1 AND 1024`,
    ),
    state: check(
      'retention_tombstones_state_check',
      sql`(${table.state} = 'raw_pending' AND ${table.rawDeletedAt} IS NULL AND ${table.applicationDeletedAt} IS NULL AND ${table.completedAt} IS NULL) OR (${table.state} = 'application_pending' AND ${table.rawDeletedAt} IS NOT NULL AND ${table.applicationDeletedAt} IS NULL AND ${table.completedAt} IS NULL) OR (${table.state} = 'completed' AND ${table.rawDeletedAt} IS NOT NULL AND ${table.applicationDeletedAt} IS NOT NULL AND ${table.completedAt} = ${table.applicationDeletedAt} AND ${table.claimToken} IS NULL)`,
    ),
    stateClaim: index('retention_tombstones_state_claim_idx').on(
      table.state,
      table.rawDeleteAfter,
      table.applicationDeleteAfter,
      table.claimExpiresAt,
      table.id,
    ),
    timestamps: check(
      'retention_tombstones_timestamps_check',
      sql`${table.messageCreatedAt} >= 0 AND ${table.rawDeleteAfter} >= ${table.messageCreatedAt} AND ${table.applicationDeleteAfter} >= ${table.rawDeleteAfter} AND ${table.attemptCount} >= 0 AND ${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt} AND (${table.rawDeletedAt} IS NULL OR ${table.rawDeletedAt} >= ${table.createdAt}) AND (${table.applicationDeletedAt} IS NULL OR (${table.rawDeletedAt} IS NOT NULL AND ${table.applicationDeletedAt} >= ${table.rawDeletedAt})) AND (${table.lastFailedAt} IS NULL OR ${table.lastFailedAt} >= ${table.createdAt}) AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
  }),
)

export const schema = {
  apiTokens,
  attachments,
  magicLinks,
  mailboxMembers,
  mailboxes,
  messageRecipients,
  messageReferences,
  messages,
  outboundSends,
  retentionTombstones,
  replyAliases,
  sessions,
  tags,
  threadTags,
  threads,
  users,
}

export type ApiTokenRow = typeof apiTokens.$inferSelect
export type AttachmentRow = typeof attachments.$inferSelect
export type MagicLinkRow = typeof magicLinks.$inferSelect
export type MailboxMemberRow = typeof mailboxMembers.$inferSelect
export type MailboxRow = typeof mailboxes.$inferSelect
export type MessageRecipientRow = typeof messageRecipients.$inferSelect
export type MessageReferenceRow = typeof messageReferences.$inferSelect
export type MessageRow = typeof messages.$inferSelect
export type OutboundSendRow = typeof outboundSends.$inferSelect
export type RetentionTombstoneRow = typeof retentionTombstones.$inferSelect
export type ReplyAliasRow = typeof replyAliases.$inferSelect
export type SessionRow = typeof sessions.$inferSelect
export type TagRow = typeof tags.$inferSelect
export type ThreadRow = typeof threads.$inferSelect
export type UserRow = typeof users.$inferSelect
