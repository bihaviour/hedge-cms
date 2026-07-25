CREATE TABLE `site_users` (
	`site_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'editor' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`site_id`, `user_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_users_user_idx` ON `site_users` (`user_id`);--> statement-breakpoint
/*
 Until now every user reached every site. Grant each existing editor and viewer their current
 role on every existing site, so nobody loses access the moment this lands. Owners and admins
 need no rows — they run the instance and reach all sites by definition.

 Sites created after this point start with no grants, which is the point of the feature: access
 to a new site is something an admin hands out.
*/
INSERT INTO `site_users` (`site_id`, `user_id`, `role`, `created_at`)
SELECT `sites`.`id`, `users`.`id`, `users`.`role`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `sites`
CROSS JOIN `users`
WHERE `users`.`role` IN ('editor', 'viewer');