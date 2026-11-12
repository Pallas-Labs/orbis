CREATE TABLE `collections` (
  `id` text PRIMARY KEY,
  `person_id` text NOT NULL,
  `name` text NOT NULL,
  `range` text NOT NULL DEFAULT 'month' CHECK (`range` IN ('month', 'quarter', 'year')),
  `source` text CHECK (`source` IN ('youtube', 'soundcloud', 'apple-music')),
  `creator_id` text,
  `creator` text,
  `tag` text,
  `minimum_minutes` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `collections_person_name` ON `collections` (`person_id`,`name` COLLATE NOCASE);
