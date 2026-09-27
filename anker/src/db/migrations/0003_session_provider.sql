DROP INDEX `interview_sessions_openclaw_session_key_uq`;
--> statement-breakpoint
CREATE TABLE `interview_sessions_new` (
	`session_id` text PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'doubao' NOT NULL,
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
	FOREIGN KEY (`story_id`) REFERENCES `stories`(`story_id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `interview_sessions_new` (
	`session_id`, `provider`, `user_id`, `stage_id`, `story_id`,
	`session_type`, `status`, `closeout_status`, `transcript_json`, `closeout_result_json`,
	`started_at`, `ended_at`, `created_at`, `updated_at`
)
SELECT
	`session_id`,
	CASE
		WHEN json_valid(`interview_sessions`.`transcript_json`) AND EXISTS (
			SELECT 1 FROM json_each(`interview_sessions`.`transcript_json`)
			WHERE json_extract(json_each.value, '$.provider') = 'qwen'
		) THEN 'qwen'
		WHEN json_valid(`interview_sessions`.`transcript_json`) AND EXISTS (
			SELECT 1 FROM json_each(`interview_sessions`.`transcript_json`)
			WHERE json_extract(json_each.value, '$.provider') = 'doubao'
		) THEN 'doubao'
		WHEN `openclaw_session_key` LIKE 'agent:closeout-agent:qwen-%' THEN 'qwen'
		WHEN `openclaw_session_key` LIKE 'agent:closeout-agent:doubao-%' THEN 'doubao'
		ELSE 'openclaw'
	END,
	`user_id`, `stage_id`, `story_id`, `session_type`, `status`, `closeout_status`,
	`transcript_json`, `closeout_result_json`, `started_at`, `ended_at`, `created_at`, `updated_at`
FROM `interview_sessions`;
--> statement-breakpoint
DROP TABLE `interview_sessions`;
--> statement-breakpoint
ALTER TABLE `interview_sessions_new` RENAME TO `interview_sessions`;
--> statement-breakpoint
CREATE INDEX `interview_sessions_user_id_idx` ON `interview_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_story_id_idx` ON `interview_sessions` (`story_id`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_stage_id_idx` ON `interview_sessions` (`stage_id`);
--> statement-breakpoint
CREATE INDEX `interview_sessions_status_idx` ON `interview_sessions` (`status`);
