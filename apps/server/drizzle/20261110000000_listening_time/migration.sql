CREATE TABLE `listening_time` (
  `person_id` text NOT NULL,
  `day` text NOT NULL,
  `set_id` text NOT NULL REFERENCES `sets`(`id`),
  `seconds` integer NOT NULL DEFAULT 0,
  PRIMARY KEY (`person_id`, `day`, `set_id`)
);--> statement-breakpoint
CREATE INDEX `listening_time_by_set` ON `listening_time` (`set_id`);
