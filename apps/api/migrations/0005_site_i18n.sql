ALTER TABLE `sites` ADD `locales` text DEFAULT '["en"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `default_locale` text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `timezone` text DEFAULT 'UTC' NOT NULL;