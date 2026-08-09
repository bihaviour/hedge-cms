CREATE TABLE `email_senders` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`reply_to` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_senders_site_email_idx` ON `email_senders` (`site_id`,`email`);--> statement-breakpoint
CREATE INDEX `email_senders_site_idx` ON `email_senders` (`site_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `newsletters` ADD `sender_id` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `member_sender_id` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `newsletter_sender_id` text;