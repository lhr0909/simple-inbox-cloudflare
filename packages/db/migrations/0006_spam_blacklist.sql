CREATE TABLE `spam_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "spam_rules_kind_check" CHECK("spam_rules"."kind" IN ('recipient', 'sender', 'domain')),
	CONSTRAINT "spam_rules_normalized_check" CHECK("spam_rules"."value" = lower(trim("spam_rules"."value")) AND length("spam_rules"."value") BETWEEN 1 AND 320)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spam_rules_owner_kind_value_idx` ON `spam_rules` (`user_id`,`kind`,`value`);