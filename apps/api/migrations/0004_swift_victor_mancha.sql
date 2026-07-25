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
CREATE UNIQUE INDEX `email_templates_key_idx` ON `email_templates` (`key`);