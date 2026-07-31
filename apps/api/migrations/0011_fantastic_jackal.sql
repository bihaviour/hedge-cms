ALTER TABLE `collections` ADD `preview_path` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `preview_url` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `preview_embed` integer DEFAULT false NOT NULL;