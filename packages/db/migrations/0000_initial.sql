CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`name` text NOT NULL,
	`scopes` integer NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "api_tokens_digest_check" CHECK(length("api_tokens"."token_digest") = 64 AND "api_tokens"."token_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "api_tokens_name_length_check" CHECK(length(trim("api_tokens"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "api_tokens_scopes_check" CHECK("api_tokens"."scopes" BETWEEN 1 AND 7),
	CONSTRAINT "api_tokens_timestamps_check" CHECK("api_tokens"."created_at" >= 0 AND ("api_tokens"."expires_at" IS NULL OR "api_tokens"."expires_at" > "api_tokens"."created_at") AND ("api_tokens"."revoked_at" IS NULL OR "api_tokens"."revoked_at" >= "api_tokens"."created_at") AND ("api_tokens"."last_used_at" IS NULL OR "api_tokens"."last_used_at" >= "api_tokens"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_digest_uidx` ON `api_tokens` (`token_digest`);--> statement-breakpoint
CREATE INDEX `api_tokens_token_expiry_idx` ON `api_tokens` (`token_digest`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_active_idx` ON `api_tokens` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`mime_ordinal` integer NOT NULL,
	`display_filename` text,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`disposition` text NOT NULL,
	`content_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "attachments_disposition_check" CHECK("attachments"."disposition" IN ('attachment', 'inline', 'unknown')),
	CONSTRAINT "attachments_media_type_normalized_check" CHECK("attachments"."media_type" = lower(trim("attachments"."media_type")) AND instr("attachments"."media_type", '/') > 1),
	CONSTRAINT "attachments_values_check" CHECK("attachments"."mime_ordinal" >= 0 AND "attachments"."size" >= 0 AND "attachments"."created_at" >= 0 AND ("attachments"."display_filename" IS NULL OR length("attachments"."display_filename") BETWEEN 1 AND 255))
);
--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`,`mime_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_message_ordinal_uidx` ON `attachments` (`message_id`,`mime_ordinal`);--> statement-breakpoint
CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`requested_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "magic_links_digest_check" CHECK(length("magic_links"."token_digest") = 64 AND "magic_links"."token_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "magic_links_timestamps_check" CHECK("magic_links"."requested_at" >= 0 AND "magic_links"."expires_at" > "magic_links"."requested_at" AND ("magic_links"."used_at" IS NULL OR "magic_links"."used_at" >= "magic_links"."requested_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_token_digest_uidx` ON `magic_links` (`token_digest`);--> statement-breakpoint
CREATE INDEX `magic_links_digest_expiry_idx` ON `magic_links` (`token_digest`,`expires_at`,`used_at`);--> statement-breakpoint
CREATE INDEX `magic_links_user_requested_idx` ON `magic_links` (`user_id`,"requested_at" desc);--> statement-breakpoint
CREATE TABLE `mailbox_members` (
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`mailbox_id`, `user_id`),
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "mailbox_members_role_check" CHECK("mailbox_members"."role" IN ('owner', 'member')),
	CONSTRAINT "mailbox_members_created_at_check" CHECK("mailbox_members"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `mailbox_members_user_idx` ON `mailbox_members` (`user_id`,`mailbox_id`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`sender_alias` text,
	`forward_to` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "mailboxes_address_normalized_check" CHECK("mailboxes"."address" = lower(trim("mailboxes"."address")) AND length("mailboxes"."address") BETWEEN 3 AND 320),
	CONSTRAINT "mailboxes_forward_to_normalized_check" CHECK("mailboxes"."forward_to" IS NULL OR ("mailboxes"."forward_to" = lower(trim("mailboxes"."forward_to")) AND length("mailboxes"."forward_to") BETWEEN 3 AND 320)),
	CONSTRAINT "mailboxes_sender_alias_length_check" CHECK("mailboxes"."sender_alias" IS NULL OR length("mailboxes"."sender_alias") BETWEEN 1 AND 200),
	CONSTRAINT "mailboxes_timestamps_check" CHECK("mailboxes"."created_at" >= 0 AND "mailboxes"."updated_at" >= "mailboxes"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_uidx` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE TABLE `message_recipients` (
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`address` text NOT NULL,
	`display_name` text,
	PRIMARY KEY(`message_id`, `kind`, `position`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "message_recipients_address_normalized_check" CHECK("message_recipients"."address" = lower(trim("message_recipients"."address")) AND length("message_recipients"."address") BETWEEN 3 AND 320),
	CONSTRAINT "message_recipients_kind_check" CHECK("message_recipients"."kind" IN ('to', 'cc', 'bcc', 'reply_to')),
	CONSTRAINT "message_recipients_position_check" CHECK("message_recipients"."position" >= 0)
);
--> statement-breakpoint
CREATE INDEX `message_recipients_address_idx` ON `message_recipients` (`address`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_recipients_message_kind_address_uidx` ON `message_recipients` (`message_id`,`kind`,`address`);--> statement-breakpoint
CREATE TABLE `message_references` (
	`message_id` text NOT NULL,
	`position` integer NOT NULL,
	`internet_message_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `position`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "message_references_position_check" CHECK("message_references"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_references_message_reference_uidx` ON `message_references` (`message_id`,`internet_message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`direction` text NOT NULL,
	`ingest_digest` text,
	`internet_message_id` text,
	`provider_message_id` text,
	`in_reply_to` text,
	`from_address` text NOT NULL,
	`from_name` text,
	`subject` text NOT NULL,
	`preview` text NOT NULL,
	`text_body` text,
	`html_body` text,
	`html_policy` text NOT NULL,
	`sent_at` integer NOT NULL,
	`received_at` integer,
	`raw_r2_key` text NOT NULL,
	`raw_size` integer NOT NULL,
	`raw_sha256` text NOT NULL,
	`raw_deleted_at` integer,
	`read_at` integer,
	`send_state` text NOT NULL,
	`forward_state` text NOT NULL,
	`provider_error_code` text,
	`retryability` text NOT NULL,
	`send_attempted_at` integer,
	`forward_attempted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`mailbox_id`) REFERENCES `threads`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "messages_direction_check" CHECK("messages"."direction" IN ('inbound', 'outbound')),
	CONSTRAINT "messages_direction_states_check" CHECK(("messages"."direction" = 'inbound' AND "messages"."send_state" = 'not_applicable' AND "messages"."forward_state" IN ('not_applicable', 'pending', 'forwarded', 'failed', 'unknown')) OR ("messages"."direction" = 'outbound' AND "messages"."send_state" IN ('queued', 'sending', 'sent', 'failed', 'unknown') AND "messages"."forward_state" = 'not_applicable')),
	CONSTRAINT "messages_provider_error_code_check" CHECK("messages"."provider_error_code" IS NULL OR (length("messages"."provider_error_code") BETWEEN 1 AND 128 AND instr("messages"."provider_error_code", char(10)) = 0 AND instr("messages"."provider_error_code", char(13)) = 0)),
	CONSTRAINT "messages_failure_state_check" CHECK(("messages"."provider_error_code" IS NOT NULL AND ("messages"."forward_state" IN ('failed', 'unknown') OR "messages"."send_state" IN ('failed', 'unknown'))) OR ("messages"."provider_error_code" IS NULL AND "messages"."forward_state" NOT IN ('failed', 'unknown') AND "messages"."send_state" NOT IN ('failed', 'unknown'))),
	CONSTRAINT "messages_html_policy_check" CHECK(("messages"."html_body" IS NULL AND "messages"."html_policy" IN ('none', 'blocked')) OR ("messages"."html_body" IS NOT NULL AND "messages"."html_policy" = 'sanitized')),
	CONSTRAINT "messages_ingest_digest_check" CHECK(("messages"."direction" = 'inbound' AND length("messages"."ingest_digest") = 64 AND "messages"."ingest_digest" NOT GLOB '*[^0-9a-f]*') OR ("messages"."direction" = 'outbound' AND "messages"."ingest_digest" IS NULL)),
	CONSTRAINT "messages_from_address_normalized_check" CHECK("messages"."from_address" = lower(trim("messages"."from_address")) AND length("messages"."from_address") BETWEEN 3 AND 320),
	CONSTRAINT "messages_raw_metadata_check" CHECK(length("messages"."raw_r2_key") BETWEEN 1 AND 1024 AND "messages"."raw_size" >= 0 AND length("messages"."raw_sha256") = 64 AND "messages"."raw_sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "messages_raw_deleted_at_check" CHECK("messages"."raw_deleted_at" IS NULL OR "messages"."raw_deleted_at" >= "messages"."created_at"),
	CONSTRAINT "messages_read_state_check" CHECK("messages"."direction" = 'inbound' OR "messages"."read_at" IS NULL),
	CONSTRAINT "messages_retryability_check" CHECK(("messages"."direction" = 'inbound' AND (("messages"."forward_state" = 'pending' AND "messages"."retryability" = 'retryable') OR ("messages"."forward_state" = 'unknown' AND "messages"."retryability" = 'manual_confirmation_required') OR ("messages"."forward_state" IN ('not_applicable', 'forwarded', 'failed') AND "messages"."retryability" = 'not_retryable'))) OR ("messages"."direction" = 'outbound' AND (("messages"."send_state" = 'queued' AND "messages"."retryability" = 'retryable') OR ("messages"."send_state" IN ('sending', 'unknown') AND "messages"."retryability" = 'manual_confirmation_required') OR ("messages"."send_state" IN ('sent', 'failed') AND "messages"."retryability" = 'not_retryable')))),
	CONSTRAINT "messages_received_state_check" CHECK("messages"."direction" = 'outbound' OR "messages"."received_at" IS NOT NULL),
	CONSTRAINT "messages_timestamps_check" CHECK("messages"."created_at" >= 0 AND "messages"."sent_at" >= 0 AND "messages"."updated_at" >= "messages"."created_at" AND ("messages"."received_at" IS NULL OR "messages"."received_at" >= 0) AND ("messages"."read_at" IS NULL OR "messages"."read_at" >= 0) AND ("messages"."send_attempted_at" IS NULL OR "messages"."send_attempted_at" >= 0) AND ("messages"."forward_attempted_at" IS NULL OR "messages"."forward_attempted_at" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_inbound_ingest_digest_uidx` ON `messages` (`ingest_digest`) WHERE "messages"."direction" = 'inbound';--> statement-breakpoint
CREATE UNIQUE INDEX `messages_mailbox_internet_message_uidx` ON `messages` (`mailbox_id`,`internet_message_id`) WHERE "messages"."internet_message_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_mailbox_uidx` ON `messages` (`id`,`mailbox_id`);--> statement-breakpoint
CREATE INDEX `messages_mailbox_thread_idx` ON `messages` (`mailbox_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_thread_sent_idx` ON `messages` (`thread_id`,`sent_at`,`id`);--> statement-breakpoint
CREATE TABLE `outbound_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text,
	`request_digest` text NOT NULL,
	`state` text NOT NULL,
	`message_id` text,
	`provider_message_id` text,
	`provider_error_code` text,
	`retryability` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_attempted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`message_id`,`mailbox_id`) REFERENCES `messages`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`thread_id`,`mailbox_id`) REFERENCES `threads`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "outbound_sends_idempotency_key_check" CHECK(length("outbound_sends"."idempotency_key") BETWEEN 16 AND 256),
	CONSTRAINT "outbound_sends_request_digest_check" CHECK(length("outbound_sends"."request_digest") = 64 AND "outbound_sends"."request_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "outbound_sends_failure_state_check" CHECK(("outbound_sends"."provider_error_code" IS NOT NULL AND "outbound_sends"."state" IN ('failed', 'unknown')) OR ("outbound_sends"."provider_error_code" IS NULL AND "outbound_sends"."state" NOT IN ('failed', 'unknown'))),
	CONSTRAINT "outbound_sends_retryability_check" CHECK(("outbound_sends"."state" = 'queued' AND "outbound_sends"."retryability" = 'retryable') OR ("outbound_sends"."state" IN ('sending', 'unknown') AND "outbound_sends"."retryability" = 'manual_confirmation_required') OR ("outbound_sends"."state" IN ('sent', 'failed') AND "outbound_sends"."retryability" = 'not_retryable')),
	CONSTRAINT "outbound_sends_state_check" CHECK("outbound_sends"."state" IN ('queued', 'sending', 'sent', 'failed', 'unknown')),
	CONSTRAINT "outbound_sends_timestamps_check" CHECK("outbound_sends"."attempt_count" >= 0 AND "outbound_sends"."created_at" >= 0 AND "outbound_sends"."updated_at" >= "outbound_sends"."created_at" AND ("outbound_sends"."last_attempted_at" IS NULL OR "outbound_sends"."last_attempted_at" >= "outbound_sends"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_sends_idempotency_key_uidx` ON `outbound_sends` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `outbound_sends_mailbox_state_idx` ON `outbound_sends` (`mailbox_id`,`state`,`updated_at`);--> statement-breakpoint
CREATE TABLE `reply_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`local_part` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`target_message_id` text,
	`relay_destination` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`target_message_id`) REFERENCES `messages`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`thread_id`,`mailbox_id`) REFERENCES `threads`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "reply_aliases_local_part_check" CHECK("reply_aliases"."local_part" = lower(trim("reply_aliases"."local_part")) AND length("reply_aliases"."local_part") BETWEEN 16 AND 128 AND "reply_aliases"."local_part" NOT GLOB '*[^a-z0-9_-]*'),
	CONSTRAINT "reply_aliases_relay_destination_normalized_check" CHECK("reply_aliases"."relay_destination" = lower(trim("reply_aliases"."relay_destination")) AND length("reply_aliases"."relay_destination") BETWEEN 3 AND 320),
	CONSTRAINT "reply_aliases_timestamps_check" CHECK("reply_aliases"."created_at" >= 0 AND ("reply_aliases"."revoked_at" IS NULL OR "reply_aliases"."revoked_at" >= "reply_aliases"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reply_aliases_local_part_uidx` ON `reply_aliases` (`local_part`);--> statement-breakpoint
CREATE UNIQUE INDEX `reply_aliases_message_destination_uidx` ON `reply_aliases` (`mailbox_id`,`target_message_id`,`relay_destination`) WHERE "reply_aliases"."target_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `reply_aliases_thread_idx` ON `reply_aliases` (`mailbox_id`,`thread_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `retention_tombstones` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`raw_r2_key` text NOT NULL,
	`message_created_at` integer NOT NULL,
	`raw_delete_after` integer NOT NULL,
	`application_delete_after` integer NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`claim_token` text,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`raw_deleted_at` integer,
	`application_deleted_at` integer,
	`last_error_code` text,
	`last_failed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "retention_tombstones_claim_check" CHECK(("retention_tombstones"."claim_token" IS NULL AND "retention_tombstones"."claimed_at" IS NULL AND "retention_tombstones"."claim_expires_at" IS NULL) OR ("retention_tombstones"."claim_token" IS NOT NULL AND length("retention_tombstones"."claim_token") BETWEEN 16 AND 128 AND instr("retention_tombstones"."claim_token", char(10)) = 0 AND instr("retention_tombstones"."claim_token", char(13)) = 0 AND "retention_tombstones"."claimed_at" IS NOT NULL AND "retention_tombstones"."claim_expires_at" > "retention_tombstones"."claimed_at")),
	CONSTRAINT "retention_tombstones_error_check" CHECK(("retention_tombstones"."last_error_code" IS NULL AND "retention_tombstones"."last_failed_at" IS NULL) OR ("retention_tombstones"."last_error_code" IS NOT NULL AND length("retention_tombstones"."last_error_code") BETWEEN 1 AND 128 AND instr("retention_tombstones"."last_error_code", char(10)) = 0 AND instr("retention_tombstones"."last_error_code", char(13)) = 0 AND "retention_tombstones"."last_failed_at" IS NOT NULL)),
	CONSTRAINT "retention_tombstones_raw_key_check" CHECK(length("retention_tombstones"."raw_r2_key") BETWEEN 1 AND 1024),
	CONSTRAINT "retention_tombstones_state_check" CHECK(("retention_tombstones"."state" = 'raw_pending' AND "retention_tombstones"."raw_deleted_at" IS NULL AND "retention_tombstones"."application_deleted_at" IS NULL AND "retention_tombstones"."completed_at" IS NULL) OR ("retention_tombstones"."state" = 'application_pending' AND "retention_tombstones"."raw_deleted_at" IS NOT NULL AND "retention_tombstones"."application_deleted_at" IS NULL AND "retention_tombstones"."completed_at" IS NULL) OR ("retention_tombstones"."state" = 'completed' AND "retention_tombstones"."raw_deleted_at" IS NOT NULL AND "retention_tombstones"."application_deleted_at" IS NOT NULL AND "retention_tombstones"."completed_at" = "retention_tombstones"."application_deleted_at" AND "retention_tombstones"."claim_token" IS NULL)),
	CONSTRAINT "retention_tombstones_timestamps_check" CHECK("retention_tombstones"."message_created_at" >= 0 AND "retention_tombstones"."raw_delete_after" >= "retention_tombstones"."message_created_at" AND "retention_tombstones"."application_delete_after" >= "retention_tombstones"."raw_delete_after" AND "retention_tombstones"."attempt_count" >= 0 AND "retention_tombstones"."created_at" >= 0 AND "retention_tombstones"."updated_at" >= "retention_tombstones"."created_at" AND ("retention_tombstones"."raw_deleted_at" IS NULL OR "retention_tombstones"."raw_deleted_at" >= "retention_tombstones"."created_at") AND ("retention_tombstones"."application_deleted_at" IS NULL OR ("retention_tombstones"."raw_deleted_at" IS NOT NULL AND "retention_tombstones"."application_deleted_at" >= "retention_tombstones"."raw_deleted_at")) AND ("retention_tombstones"."last_failed_at" IS NULL OR "retention_tombstones"."last_failed_at" >= "retention_tombstones"."created_at") AND ("retention_tombstones"."completed_at" IS NULL OR "retention_tombstones"."completed_at" >= "retention_tombstones"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `retention_tombstones_message_uidx` ON `retention_tombstones` (`message_id`);--> statement-breakpoint
CREATE INDEX `retention_tombstones_state_claim_idx` ON `retention_tombstones` (`state`,`raw_delete_after`,`application_delete_after`,`claim_expires_at`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_digest` text NOT NULL,
	`source_magic_link_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`source_magic_link_id`) REFERENCES `magic_links`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "sessions_digest_check" CHECK(length("sessions"."token_digest") = 64 AND "sessions"."token_digest" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "sessions_timestamps_check" CHECK("sessions"."created_at" >= 0 AND "sessions"."last_seen_at" >= "sessions"."created_at" AND "sessions"."expires_at" > "sessions"."created_at" AND ("sessions"."revoked_at" IS NULL OR "sessions"."revoked_at" >= "sessions"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_digest_uidx` ON `sessions` (`token_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_source_magic_link_uidx` ON `sessions` (`source_magic_link_id`);--> statement-breakpoint
CREATE INDEX `sessions_token_expiry_idx` ON `sessions` (`token_digest`,`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `sessions_user_active_idx` ON `sessions` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "tags_normalized_name_check" CHECK("tags"."normalized_name" = lower(trim("tags"."normalized_name")) AND length("tags"."normalized_name") BETWEEN 1 AND 100 AND length(trim("tags"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "tags_created_at_check" CHECK("tags"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_id_mailbox_uidx` ON `tags` (`id`,`mailbox_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_mailbox_name_uidx` ON `tags` (`mailbox_id`,`normalized_name`);--> statement-breakpoint
CREATE TABLE `thread_tags` (
	`thread_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `tag_id`),
	FOREIGN KEY (`tag_id`,`mailbox_id`) REFERENCES `tags`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`thread_id`,`mailbox_id`) REFERENCES `threads`(`id`,`mailbox_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "thread_tags_created_at_check" CHECK("thread_tags"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `thread_tags_tag_idx` ON `thread_tags` (`tag_id`,`thread_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`subject` text NOT NULL,
	`normalized_subject` text NOT NULL,
	`workflow_state` text NOT NULL,
	`archived_at` integer,
	`latest_message_id` text,
	`last_message_at` integer NOT NULL,
	`last_message_preview` text NOT NULL,
	`last_message_direction` text,
	`last_sender_address` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`unread_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`latest_message_id`) REFERENCES `messages`(`id`) ON UPDATE cascade ON DELETE set null,
	CONSTRAINT "threads_aggregate_counts_check" CHECK("threads"."message_count" >= 0 AND "threads"."unread_count" >= 0 AND "threads"."unread_count" <= "threads"."message_count"),
	CONSTRAINT "threads_archive_timestamp_check" CHECK("threads"."archived_at" IS NULL OR "threads"."archived_at" >= "threads"."created_at"),
	CONSTRAINT "threads_last_direction_check" CHECK("threads"."last_message_direction" IS NULL OR "threads"."last_message_direction" IN ('inbound', 'outbound')),
	CONSTRAINT "threads_last_sender_normalized_check" CHECK("threads"."last_sender_address" IS NULL OR "threads"."last_sender_address" = lower(trim("threads"."last_sender_address"))),
	CONSTRAINT "threads_timestamps_check" CHECK("threads"."created_at" >= 0 AND "threads"."last_message_at" >= 0 AND "threads"."updated_at" >= "threads"."created_at"),
	CONSTRAINT "threads_workflow_state_check" CHECK("threads"."workflow_state" IN ('needs_reply', 'waiting', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX `threads_mailbox_archive_order_idx` ON `threads` (`mailbox_id`,`archived_at`,"last_message_at" desc,"id" desc);--> statement-breakpoint
CREATE UNIQUE INDEX `threads_id_mailbox_uidx` ON `threads` (`id`,`mailbox_id`);--> statement-breakpoint
CREATE INDEX `threads_mailbox_unread_order_idx` ON `threads` (`mailbox_id`,`unread_count`,`archived_at`,"last_message_at" desc,"id" desc);--> statement-breakpoint
CREATE INDEX `threads_mailbox_workflow_archive_order_idx` ON `threads` (`mailbox_id`,`workflow_state`,`archived_at`,"last_message_at" desc,"id" desc);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	CONSTRAINT "users_email_normalized_check" CHECK("users"."email" = lower(trim("users"."email")) AND length("users"."email") BETWEEN 3 AND 320),
	CONSTRAINT "users_timestamps_check" CHECK("users"."created_at" >= 0 AND ("users"."disabled_at" IS NULL OR "users"."disabled_at" >= "users"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_uidx` ON `users` (`email`);
--> statement-breakpoint

-- This is a contentful FTS table (not external-content). Participant and tag
-- text spans normalized tables, so repositories replace the row in the same
-- D1 batch as each projection change.
CREATE VIRTUAL TABLE message_search USING fts5(
  message_id UNINDEXED,
  thread_id UNINDEXED,
  mailbox_id UNINDEXED,
  subject,
  participants,
  body,
  tags,
  workflow_state,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3 4'
);
--> statement-breakpoint

CREATE TRIGGER threads_validate_latest_message_insert
BEFORE INSERT ON threads
WHEN NEW.latest_message_id IS NOT NULL
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = NEW.latest_message_id
      AND messages.thread_id = NEW.id
      AND messages.mailbox_id = NEW.mailbox_id
  ) THEN RAISE(ABORT, 'latest message must belong to thread') END);
END;
--> statement-breakpoint

CREATE TRIGGER threads_validate_latest_message_update
BEFORE UPDATE OF latest_message_id, mailbox_id ON threads
WHEN NEW.latest_message_id IS NOT NULL
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = NEW.latest_message_id
      AND messages.thread_id = NEW.id
      AND messages.mailbox_id = NEW.mailbox_id
  ) THEN RAISE(ABORT, 'latest message must belong to thread') END);
END;
--> statement-breakpoint

CREATE TRIGGER reply_aliases_validate_target_insert
BEFORE INSERT ON reply_aliases
WHEN NEW.target_message_id IS NOT NULL
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = NEW.target_message_id
      AND messages.thread_id = NEW.thread_id
      AND messages.mailbox_id = NEW.mailbox_id
  ) THEN RAISE(ABORT, 'reply target must belong to thread') END);
END;
--> statement-breakpoint

CREATE TRIGGER reply_aliases_validate_target_update
BEFORE UPDATE OF target_message_id, thread_id, mailbox_id ON reply_aliases
WHEN NEW.target_message_id IS NOT NULL
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM messages
    WHERE messages.id = NEW.target_message_id
      AND messages.thread_id = NEW.thread_id
      AND messages.mailbox_id = NEW.mailbox_id
  ) THEN RAISE(ABORT, 'reply target must belong to thread') END);
END;
--> statement-breakpoint

CREATE TRIGGER outbound_sends_validate_actor_insert
BEFORE INSERT ON outbound_sends
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_members
    WHERE mailbox_members.mailbox_id = NEW.mailbox_id
      AND mailbox_members.user_id = NEW.actor_user_id
  ) THEN RAISE(ABORT, 'send actor must be a mailbox member') END);
END;
--> statement-breakpoint

CREATE TRIGGER outbound_sends_validate_actor_update
BEFORE UPDATE OF actor_user_id, mailbox_id ON outbound_sends
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
    FROM mailbox_members
    WHERE mailbox_members.mailbox_id = NEW.mailbox_id
      AND mailbox_members.user_id = NEW.actor_user_id
  ) THEN RAISE(ABORT, 'send actor must be a mailbox member') END);
END;
--> statement-breakpoint

CREATE TRIGGER messages_search_delete
AFTER DELETE ON messages
BEGIN
  DELETE FROM message_search WHERE message_id = OLD.id;
END;
--> statement-breakpoint

CREATE TRIGGER threads_search_workflow_update
AFTER UPDATE OF workflow_state ON threads
BEGIN
  UPDATE message_search
  SET workflow_state = NEW.workflow_state
  WHERE thread_id = NEW.id AND mailbox_id = NEW.mailbox_id;
END;
