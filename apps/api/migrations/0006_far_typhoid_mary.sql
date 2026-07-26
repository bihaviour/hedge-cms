CREATE TABLE `email_config` (
	`id` text PRIMARY KEY NOT NULL,
	`from_email` text,
	`from_name` text,
	`reply_to` text,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`template_key` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_log_created_at_idx` ON `email_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`subject` text NOT NULL,
	`heading` text NOT NULL,
	`body` text NOT NULL,
	`cta_label` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_templates_key_idx` ON `email_templates` (`key`);--> statement-breakpoint
CREATE TABLE `newsletter_subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`status` text DEFAULT 'subscribed' NOT NULL,
	`source` text,
	`unsubscribed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `newsletter_subscribers_site_email_idx` ON `newsletter_subscribers` (`site_id`,`email`);--> statement-breakpoint
CREATE INDEX `newsletter_subscribers_site_idx` ON `newsletter_subscribers` (`site_id`);--> statement-breakpoint
CREATE TABLE `newsletter_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `newsletter_templates_site_idx` ON `newsletter_templates` (`site_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `newsletters` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`audience` text DEFAULT 'both' NOT NULL,
	`sent_at` text,
	`recipient_count` integer,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `newsletters_site_idx` ON `newsletters` (`site_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `member_sites` ADD `newsletter_subscribed` integer DEFAULT true NOT NULL;