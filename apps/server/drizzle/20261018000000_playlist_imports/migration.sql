CREATE TABLE `playlist_imports` (
  `id` text PRIMARY KEY,
  `person_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `source_playlist_id` text NOT NULL,
  `source_url` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('running', 'done', 'failed')),
  `page_token` text,
  `processed` integer NOT NULL DEFAULT 0,
  `total` integer,
  `added` integer NOT NULL DEFAULT 0,
  `unavailable` integer NOT NULL DEFAULT 0,
  `over_limit` integer NOT NULL DEFAULT 0,
  `downloading` integer NOT NULL DEFAULT 0,
  `waiting` integer NOT NULL DEFAULT 0,
  `failure` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  CHECK ((`state` = 'failed') = (`failure` IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `playlist_imports_running_unique` ON `playlist_imports` (`person_id`,`source_playlist_id`) WHERE `state` = 'running';--> statement-breakpoint
CREATE INDEX `playlist_imports_by_state` ON `playlist_imports` (`state`,`updated_at`);
