ALTER TABLE `messages` ADD `inbox` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `starred_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `trashed_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `spam_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `spam_reason` text;
--> statement-breakpoint
UPDATE messages SET inbox = CASE WHEN direction = 'inbound' AND EXISTS (SELECT 1 FROM threads t WHERE t.id = messages.thread_id AND t.archived_at IS NULL) THEN 1 ELSE 0 END;
