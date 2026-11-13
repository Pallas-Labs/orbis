CREATE TABLE `set_analysis` (
  `set_id` text PRIMARY KEY REFERENCES `sets`(`id`) ON DELETE CASCADE,
  `analysis` text NOT NULL,
  `updated_at` text NOT NULL
);
