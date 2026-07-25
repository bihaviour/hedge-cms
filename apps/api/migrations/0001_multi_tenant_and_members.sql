CREATE TABLE `sites` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`domain` text,
	`allow_member_signup` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_idx` ON `sites` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `sites_domain_idx` ON `sites` (`domain`);--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`password_hash` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_site_email_idx` ON `members` (`site_id`,`email`);--> statement-breakpoint
CREATE TABLE `member_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `member_sessions_member_idx` ON `member_sessions` (`member_id`);--> statement-breakpoint
ALTER TABLE `entries` ADD `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
/*
 Everything that existed before this migration belonged to a single implicit site. Create it and
 move all of that content onto it, so a single-site install sees no change.

 Only for an instance that was already in use, which is what the `users` check means: a database
 migrated from empty has nothing to move, and its first site is the one the owner names in the
 onboarding wizard. Handing them a site called "Default site" would be a decision made for them.

 `site_id` is NOT NULL and carries a foreign key, which SQLite cannot add to an existing table —
 hence the create/copy/drop/rename dance below rather than a plain ADD COLUMN.
*/
INSERT INTO `sites` (`id`, `slug`, `name`, `description`, `domain`, `allow_member_signup`, `created_at`, `updated_at`)
SELECT
	'sit_default',
	'default',
	'Default site',
	'Created automatically when this instance moved to multi-site.',
	NULL,
	1,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM `users`);
--> statement-breakpoint
PRAGMA defer_foreign_keys = on;--> statement-breakpoint
CREATE TABLE `__new_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text DEFAULT 'multiple' NOT NULL,
	`fields` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_collections` (`id`, `site_id`, `slug`, `name`, `description`, `kind`, `fields`, `created_at`, `updated_at`)
SELECT `id`, 'sit_default', `slug`, `name`, `description`, `kind`, `fields`, `created_at`, `updated_at` FROM `collections`;--> statement-breakpoint
DROP TABLE `collections`;--> statement-breakpoint
ALTER TABLE `__new_collections` RENAME TO `collections`;--> statement-breakpoint
CREATE UNIQUE INDEX `collections_site_slug_idx` ON `collections` (`site_id`,`slug`);--> statement-breakpoint
CREATE TABLE `__new_media` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`key` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`alt` text,
	`uploaded_by` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_media` (`id`, `site_id`, `key`, `filename`, `content_type`, `size`, `width`, `height`, `alt`, `uploaded_by`, `created_at`)
SELECT `id`, 'sit_default', `key`, `filename`, `content_type`, `size`, `width`, `height`, `alt`, `uploaded_by`, `created_at` FROM `media`;--> statement-breakpoint
DROP TABLE `media`;--> statement-breakpoint
ALTER TABLE `__new_media` RENAME TO `media`;--> statement-breakpoint
CREATE UNIQUE INDEX `media_key_idx` ON `media` (`key`);--> statement-breakpoint
CREATE INDEX `media_site_created_at_idx` ON `media` (`site_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`created_by` text,
	`last_used_at` text,
	`expires_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_api_keys` (`id`, `site_id`, `name`, `prefix`, `key_hash`, `scopes`, `created_by`, `last_used_at`, `expires_at`, `created_at`)
SELECT `id`, 'sit_default', `name`, `prefix`, `key_hash`, `scopes`, `created_by`, `last_used_at`, `expires_at`, `created_at` FROM `api_keys`;--> statement-breakpoint
DROP TABLE `api_keys`;--> statement-breakpoint
ALTER TABLE `__new_api_keys` RENAME TO `api_keys`;--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_hash_idx` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_site_idx` ON `api_keys` (`site_id`);
