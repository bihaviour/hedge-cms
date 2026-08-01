CREATE TABLE `login_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`session_cookies` text NOT NULL,
	`session_token` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`user_agent` text,
	`ip_address` text,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `login_challenges_user_idx` ON `login_challenges` (`user_id`);--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_hash` text NOT NULL,
	`label` text NOT NULL,
	`last_used_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trusted_devices_hash_idx` ON `trusted_devices` (`device_hash`);--> statement-breakpoint
CREATE INDEX `trusted_devices_user_idx` ON `trusted_devices` (`user_id`);