-- Hand-completed after drizzle-kit: it emits a bare `ADD ... NOT NULL`, which SQLite refuses on a
-- table that already has rows, and it has no way to know what the backfill should be.
-- The `DEFAULT ''` exists only so the ALTER is legal. The column is `.notNull()` with no default in
-- schema.ts on purpose, so TypeScript refuses an insert that omits it rather than letting one land
-- in the empty group with every other row that forgot.
ALTER TABLE `entries` ADD `translation_group_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Grouping was implied by the slug before this column existed, and `applyGeneratedCodes` already
-- treated any locale of a slug as the same piece. So the backfill is that same rule written down:
-- every locale of one (collection, slug) becomes one group. Derived from the lowest entry id in the
-- set rather than a generated value, because SQL has no `newId()` and an entry id is already unique
-- across the deployment, which makes the group id unique too.
UPDATE `entries` SET `translation_group_id` = 'tgr' || substr((SELECT min(sibling.`id`) FROM `entries` AS sibling WHERE sibling.`collection_id` = `entries`.`collection_id` AND sibling.`slug` = `entries`.`slug`), 4);--> statement-breakpoint
CREATE INDEX `entries_translation_group_idx` ON `entries` (`translation_group_id`,`locale`);
