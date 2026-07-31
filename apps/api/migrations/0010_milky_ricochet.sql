CREATE TABLE `analytics_daily` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`date` text NOT NULL,
	`entry_id` text,
	`path` text DEFAULT '' NOT NULL,
	`metric` text NOT NULL,
	`key` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_daily_bucket_idx` ON `analytics_daily` (`site_id`,`date`,`path`,`metric`,`key`);--> statement-breakpoint
CREATE INDEX `analytics_daily_site_date_idx` ON `analytics_daily` (`site_id`,`date`);--> statement-breakpoint
CREATE INDEX `analytics_daily_site_entry_idx` ON `analytics_daily` (`site_id`,`entry_id`,`date`);