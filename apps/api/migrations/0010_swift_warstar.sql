CREATE TABLE `entry_version_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`level` integer NOT NULL,
	`decision` text NOT NULL,
	`user_id` text,
	`comment` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `entry_versions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `entry_version_approvals_version_idx` ON `entry_version_approvals` (`version_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `entry_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`title` text NOT NULL,
	`data` text NOT NULL,
	`metadata` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`base_updated_at` text NOT NULL,
	`created_by` text,
	`submitted_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `entry_versions_entry_idx` ON `entry_versions` (`entry_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `entry_versions_site_status_idx` ON `entry_versions` (`site_id`,`status`);--> statement-breakpoint
ALTER TABLE `collections` ADD `approval_levels` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `site_users` ADD `approval_level` integer;