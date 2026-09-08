-- Replace only the preference column to change its SQLite default without rebuilding
-- mailboxes or cascading into related mail. All existing inboxes intentionally opt in.
ALTER TABLE `mailboxes` ADD `forward_html_default` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `mailboxes` DROP COLUMN `forward_html`;--> statement-breakpoint
ALTER TABLE `mailboxes` RENAME COLUMN `forward_html_default` TO `forward_html`;
