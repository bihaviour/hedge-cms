/*
 Moves identity onto Better Auth.

 Three things are worth knowing before running this:

 1. Everyone is signed out. Sessions used to be stored as an HMAC of the token with the token
    itself never kept, so there is nothing to migrate them from — the table is rebuilt empty.
 2. No password is lost. Hashes move from `users.password_hash` into `accounts.password` in the
    same `pbkdf2$iterations$salt$hash` format, which is what Better Auth is configured to read.
 3. Members become one identity per deployment instead of one per site. A reader who signed up on
    two sites with the same address had two unrelated accounts; they now have one, with a grant in
    `member_sites` for each site. Duplicates collapse onto the earliest account, and the earliest
    password that exists for that address is the one kept.

 Tables Better Auth owns store dates as epoch seconds, so ISO strings are converted on the way in.
*/
PRAGMA defer_foreign_keys = on;--> statement-breakpoint

/* ---------- CMS users ---------- */

CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`role` text DEFAULT 'editor' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users` (`id`, `email`, `name`, `email_verified`, `image`, `role`, `created_at`, `updated_at`)
SELECT
	`id`,
	`email`,
	`name`,
	/* Having a password means they followed an invite link sent to this address. Written as a bare
	   comparison, not a CASE: wrangler's SQL splitter treats CASE as a compound-statement start and
	   only closes it on `END` followed by whitespace, so `END,` swallows every later `;` and the
	   rest of the file is sent to D1 as one statement. */
	`password_hash` IS NOT NULL,
	NULL,
	`role`,
	CAST(strftime('%s', `created_at`) AS INTEGER),
	CAST(strftime('%s', `updated_at`) AS INTEGER)
FROM `users`;
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `accounts` (`id`, `user_id`, `account_id`, `provider_id`, `password`, `created_at`, `updated_at`)
SELECT
	'acc_' || `id`,
	`id`,
	`id`,
	'credential',
	`password_hash`,
	CAST(strftime('%s', `created_at`) AS INTEGER),
	CAST(strftime('%s', `updated_at`) AS INTEGER)
FROM `users`
WHERE `password_hash` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_account_idx` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint

/* ---------- Admin sessions ---------- */

DROP TABLE `sessions`;--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_idx` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint

/* ---------- Verification, rate limiting ---------- */

CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_key_idx` ON `rate_limits` (`key`);--> statement-breakpoint
/* Password resets are Better Auth's verification rows now; only invites are left here. */
DELETE FROM `auth_tokens` WHERE `purpose` = 'password_reset';--> statement-breakpoint

/* ---------- OAuth 2.1, for MCP clients ---------- */

CREATE TABLE `oauth_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`metadata` text,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_urls` text NOT NULL,
	`type` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_applications_client_id_idx` ON `oauth_applications` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`refresh_token_expires_at` integer NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_tokens_access_idx` ON `oauth_access_tokens` (`access_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_tokens_refresh_idx` ON `oauth_access_tokens` (`refresh_token`);--> statement-breakpoint
CREATE INDEX `oauth_access_tokens_user_idx` ON `oauth_access_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`consent_given` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_consents_user_client_idx` ON `oauth_consents` (`user_id`,`client_id`);--> statement-breakpoint

/* ---------- Members ---------- */

DROP TABLE `member_sessions`;--> statement-breakpoint
ALTER TABLE `members` RENAME TO `__old_members`;--> statement-breakpoint
DROP INDEX IF EXISTS `members_site_email_idx`;--> statement-breakpoint
CREATE TABLE `members` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
/* One row per address. Ids sort by creation time, so MIN(id) is the account they made first. */
INSERT INTO `members` (`id`, `email`, `name`, `email_verified`, `image`, `created_at`, `updated_at`)
SELECT
	`m`.`id`,
	`m`.`email`,
	`m`.`name`,
	0,
	NULL,
	CAST(strftime('%s', `m`.`created_at`) AS INTEGER),
	CAST(strftime('%s', `m`.`updated_at`) AS INTEGER)
FROM `__old_members` `m`
WHERE `m`.`id` = (SELECT MIN(`o`.`id`) FROM `__old_members` `o` WHERE `o`.`email` = `m`.`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_idx` ON `members` (`email`);--> statement-breakpoint
CREATE TABLE `member_sites` (
	`site_id` text NOT NULL,
	`member_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_login_at` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`site_id`, `member_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
/* Every old row was a membership of one site — that is exactly what a grant is. */
INSERT INTO `member_sites` (`site_id`, `member_id`, `status`, `last_login_at`, `created_at`)
SELECT
	`m`.`site_id`,
	(SELECT MIN(`o`.`id`) FROM `__old_members` `o` WHERE `o`.`email` = `m`.`email`),
	`m`.`status`,
	`m`.`last_login_at`,
	`m`.`created_at`
FROM `__old_members` `m`;
--> statement-breakpoint
CREATE INDEX `member_sites_member_idx` ON `member_sites` (`member_id`);--> statement-breakpoint
CREATE TABLE `member_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`password` text,
	`access_token` text,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`id_token` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `member_accounts` (`id`, `member_id`, `account_id`, `provider_id`, `password`, `created_at`, `updated_at`)
SELECT
	'mac_' || `n`.`id`,
	`n`.`id`,
	`n`.`id`,
	'credential',
	(
		SELECT `o`.`password_hash` FROM `__old_members` `o`
		WHERE `o`.`email` = `n`.`email` AND `o`.`password_hash` IS NOT NULL
		ORDER BY `o`.`id` LIMIT 1
	),
	`n`.`created_at`,
	`n`.`updated_at`
FROM `members` `n`
WHERE EXISTS (
	SELECT 1 FROM `__old_members` `o`
	WHERE `o`.`email` = `n`.`email` AND `o`.`password_hash` IS NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_accounts_member_idx` ON `member_accounts` (`member_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_accounts_provider_account_idx` ON `member_accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `member_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`member_id` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`member_id`) REFERENCES `members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_sessions_token_idx` ON `member_sessions` (`token`);--> statement-breakpoint
CREATE INDEX `member_sessions_member_idx` ON `member_sessions` (`member_id`);--> statement-breakpoint
CREATE TABLE `member_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `member_verifications_identifier_idx` ON `member_verifications` (`identifier`);--> statement-breakpoint
DROP TABLE `__old_members`;
