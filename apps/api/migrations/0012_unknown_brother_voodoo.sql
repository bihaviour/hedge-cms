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
--> statement-breakpoint
-- === email_log.newsletter_id ===
-- Hand-written rather than drizzle-kit's ALTER TABLE ADD COLUMN. SQLite does allow adding a
-- nullable column carrying a REFERENCES clause, but drizzle-kit emitted that clause with no ON
-- DELETE action, which leaves the default NO ACTION. That restricts, so deleting a campaign would
-- start failing the moment it had log rows. A create/copy/drop/rename rebuild is the only way to
-- get ON DELETE set null onto the column.
-- Nothing else references email_log, so dropping it needs no foreign-key juggling.
CREATE TABLE `__new_email_log` (
	`id` text PRIMARY KEY NOT NULL,
	`to` text NOT NULL,
	`subject` text NOT NULL,
	`template_key` text,
	`newsletter_id` text,
	`status` text NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`newsletter_id`) REFERENCES `newsletters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Existing rows keep a null newsletter_id, which honestly means "sent before this was recorded"
-- rather than "not a newsletter". Backfilling from a matching subject line is exactly the guess
-- this column exists to stop anyone making.
INSERT INTO `__new_email_log` (`id`, `to`, `subject`, `template_key`, `newsletter_id`, `status`, `error`, `created_at`)
SELECT `id`, `to`, `subject`, `template_key`, NULL, `status`, `error`, `created_at` FROM `email_log`;
--> statement-breakpoint
DROP TABLE `email_log`;
--> statement-breakpoint
ALTER TABLE `__new_email_log` RENAME TO `email_log`;
--> statement-breakpoint
CREATE INDEX `email_log_created_at_idx` ON `email_log` (`created_at`);
--> statement-breakpoint
CREATE INDEX `email_log_newsletter_idx` ON `email_log` (`newsletter_id`);
