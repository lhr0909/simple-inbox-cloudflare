ALTER TABLE `mailboxes` ADD `whitelisted` integer DEFAULT false NOT NULL;
--> statement-breakpoint
-- Preserve existing inboxes; only newly discovered addresses start quiet.
UPDATE mailboxes SET whitelisted = 1;
