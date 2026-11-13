-- Per-Person tables replaced these columns: `listens` (20260929150000_person_listens) and
-- `playback_positions` (20260928150000_person_playback) copied their values, and nothing reads them now.
ALTER TABLE `sets` DROP COLUMN `playback_position_seconds`;--> statement-breakpoint
ALTER TABLE `sets` DROP COLUMN `listen_count`;--> statement-breakpoint
ALTER TABLE `sets` DROP COLUMN `finish_count`;--> statement-breakpoint
ALTER TABLE `sets` DROP COLUMN `last_listened_at`;
