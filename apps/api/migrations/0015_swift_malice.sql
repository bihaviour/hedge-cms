ALTER TABLE `newsletters` ADD `from_email` text;--> statement-breakpoint
ALTER TABLE `newsletters` ADD `from_name` text;--> statement-breakpoint
ALTER TABLE `newsletters` ADD `reply_to` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `newsletter_from` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `newsletter_from_name` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `newsletter_reply_to` text;