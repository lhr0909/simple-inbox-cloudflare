CREATE TABLE `api_token_mailboxes` (
	`token_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	PRIMARY KEY(`token_id`, `mailbox_id`),
	FOREIGN KEY (`token_id`) REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `all_mailboxes` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `uploaded_files` ADD `api_token_id` text REFERENCES api_tokens(id);