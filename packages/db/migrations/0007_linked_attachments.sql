CREATE TABLE `uploaded_files` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`multipart_id` text NOT NULL,
	`download_token` text NOT NULL,
	`etag` text,
	`outbound_send_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`outbound_send_id`) REFERENCES `outbound_sends`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_files_object_key_unique` ON `uploaded_files` (`object_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uploaded_files_download_token_unique` ON `uploaded_files` (`download_token`);