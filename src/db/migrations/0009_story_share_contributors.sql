CREATE TABLE `story_share_links` (
  `share_id` text PRIMARY KEY NOT NULL,
  `story_id` text NOT NULL,
  `user_id` text NOT NULL,
  `token_hash` text NOT NULL,
  `relationship` text NOT NULL,
  `contributor_summary` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `expires_at` text NOT NULL,
  `interview_count` integer DEFAULT 0 NOT NULL,
  `last_interview_at` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`story_id`) REFERENCES `stories`(`story_id`) ON UPDATE cascade ON DELETE cascade,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `story_share_links_token_hash_uq` ON `story_share_links` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `story_share_links_user_story_idx` ON `story_share_links` (`user_id`,`story_id`);
--> statement-breakpoint
CREATE INDEX `story_share_links_story_idx` ON `story_share_links` (`story_id`);
--> statement-breakpoint
CREATE INDEX `story_share_links_expires_idx` ON `story_share_links` (`expires_at`);
--> statement-breakpoint
ALTER TABLE `interview_sessions` ADD `source_type` text DEFAULT 'subject' NOT NULL;
--> statement-breakpoint
ALTER TABLE `interview_sessions` ADD `source_share_id` text REFERENCES story_share_links(share_id) ON UPDATE cascade ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `interview_sessions_source_share_id_idx` ON `interview_sessions` (`source_share_id`);
