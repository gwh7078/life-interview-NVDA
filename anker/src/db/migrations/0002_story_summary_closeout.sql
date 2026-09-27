UPDATE `interview_sessions`
SET `closeout_result_json` = json_remove(
	`closeout_result_json`,
	'$.previous_story_state',
	'$.new_story_state',
	'$.changes',
	'$.conflicts',
	'$.new_story_candidates',
	'$.readiness_assessment'
)
WHERE `closeout_result_json` IS NOT NULL AND json_valid(`closeout_result_json`);
--> statement-breakpoint
DROP TABLE `story_candidates`;
--> statement-breakpoint
CREATE TABLE `stories_new` (
	`story_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`title` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_source_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `life_stages`(`stage_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `stories_new` (
	`story_id`, `user_id`, `stage_id`, `title`, `summary`, `status`,
	`created_source_session_id`, `created_at`, `updated_at`
)
SELECT
	`story_id`,
	`user_id`,
	`stage_id`,
	`title`,
	CASE
		WHEN COALESCE(NULLIF(TRIM(`short_summary`), ''), '') = '' THEN
			CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END
		WHEN CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END = '' THEN `short_summary`
		WHEN instr(lower(`short_summary`), lower(CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END)) > 0 THEN `short_summary`
		WHEN instr(lower(CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END), lower(`short_summary`)) > 0 THEN
			CASE WHEN length(`short_summary`) >= length(CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END)
				THEN `short_summary`
				ELSE CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END
			END
		ELSE TRIM(`short_summary`) || char(10) || char(10) || TRIM(CASE WHEN json_valid(`story_state_json`) THEN COALESCE(json_extract(`story_state_json`, '$.summary'), '') ELSE '' END)
	END,
	CASE WHEN `status` = 'mostly_complete' THEN 'interviewing' ELSE `status` END,
	`created_source_session_id`, `created_at`, `updated_at`
FROM `stories`;
--> statement-breakpoint
CREATE TABLE `interview_sessions_new` (
	`session_id` text PRIMARY KEY NOT NULL,
	`openclaw_session_key` text NOT NULL,
	`user_id` text NOT NULL,
	`stage_id` text,
	`story_id` text,
	`session_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`closeout_status` text DEFAULT 'pending' NOT NULL,
	`transcript_json` text DEFAULT '[]' NOT NULL,
	`closeout_result_json` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `life_stages`(`stage_id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`story_id`) REFERENCES `stories_new`(`story_id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `interview_sessions_new` (
	`session_id`, `openclaw_session_key`, `user_id`, `stage_id`, `story_id`,
	`session_type`, `status`, `closeout_status`, `transcript_json`, `closeout_result_json`,
	`started_at`, `ended_at`, `created_at`, `updated_at`
)
SELECT
	`session_id`, `openclaw_session_key`, `user_id`, `stage_id`, `story_id`,
	`session_type`, `status`, `closeout_status`, `transcript_json`, `closeout_result_json`,
	`started_at`, `ended_at`, `created_at`, `updated_at`
FROM `interview_sessions`;
--> statement-breakpoint
DROP TABLE `interview_sessions`;
--> statement-breakpoint
ALTER TABLE `interview_sessions_new` RENAME TO `interview_sessions`;
--> statement-breakpoint
DROP TABLE `stories`;
--> statement-breakpoint
ALTER TABLE `stories_new` RENAME TO `stories`;
--> statement-breakpoint
CREATE INDEX `stories_user_id_idx` ON `stories` (`user_id`);
--> statement-breakpoint
CREATE INDEX `stories_stage_id_idx` ON `stories` (`stage_id`);
--> statement-breakpoint
CREATE INDEX `stories_user_stage_idx` ON `stories` (`user_id`,`stage_id`);
--> statement-breakpoint
CREATE INDEX `stories_status_idx` ON `stories` (`status`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_user_id_idx` ON `interview_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_story_id_idx` ON `interview_sessions` (`story_id`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_stage_id_idx` ON `interview_sessions` (`stage_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_sessions_openclaw_session_key_uq` ON `interview_sessions` (`openclaw_session_key`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_status_idx` ON `interview_sessions` (`status`);
