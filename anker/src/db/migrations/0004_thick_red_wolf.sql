CREATE TABLE `accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`phone` text,
	`phone_verified` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_phone_uq` ON `accounts` (`phone`);
--> statement-breakpoint
INSERT INTO `accounts` (`account_id`, `phone`, `phone_verified`, `status`, `created_at`, `updated_at`)
SELECT `account_id`, `phone`, 0, `account_status`, `created_at`, `updated_at`
FROM `__codex_user_account_backfill`;
--> statement-breakpoint
CREATE TABLE `users_new` (
	`user_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text,
	`nickname` text,
	`email` text,
	`birth_date` text,
	`birth_date_precision` text,
	`birth_place` text,
	`current_location` text,
	`occupation_summary` text,
	`family_summary` text,
	`profile_summary` text,
	`extra_profile_json` text,
	`onboarding_status` text DEFAULT 'not_started' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`account_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `users_new` (`user_id`, `account_id`, `name`, `nickname`, `email`, `birth_date`, `birth_date_precision`, `birth_place`, `current_location`, `occupation_summary`, `family_summary`, `profile_summary`, `extra_profile_json`, `onboarding_status`, `created_at`, `updated_at`)
SELECT `users`.`user_id`, `backfill`.`account_id`, `users`.`name`, `users`.`nickname`, `users`.`email`, `users`.`birth_date`, `users`.`birth_date_precision`, `users`.`birth_place`, `users`.`current_location`, `users`.`occupation_summary`, `users`.`family_summary`, `users`.`profile_summary`, `users`.`extra_profile_json`, `users`.`onboarding_status`, `users`.`created_at`, `users`.`updated_at`
FROM `users` JOIN `__codex_user_account_backfill` AS `backfill` ON `backfill`.`user_id` = `users`.`user_id`;
--> statement-breakpoint
DROP TABLE `users`;
--> statement-breakpoint
ALTER TABLE `users_new` RENAME TO `users`;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_account_id_uq` ON `users` (`account_id`);
--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);
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
	FOREIGN KEY (`stage_id`) REFERENCES `life_stages`(`stage_id`) ON UPDATE cascade ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `stories_new` (`story_id`, `user_id`, `stage_id`, `title`, `summary`, `status`, `created_source_session_id`, `created_at`, `updated_at`)
SELECT `story_id`, `user_id`, `stage_id`, `title`, `summary`, `status`, `created_source_session_id`, `created_at`, `updated_at` FROM `stories`;
--> statement-breakpoint
DROP TABLE `stories`;
--> statement-breakpoint
ALTER TABLE `stories_new` RENAME TO `stories`;
--> statement-breakpoint
CREATE INDEX `stories_user_id_idx` ON `stories` (`user_id`);
--> statement-breakpoint
CREATE INDEX `stories_stage_id_idx` ON `stories` (`stage_id`);
--> statement-breakpoint
CREATE INDEX `stories_user_stage_idx` ON `stories` (`user_id`, `stage_id`);
--> statement-breakpoint
CREATE INDEX `stories_status_idx` ON `stories` (`status`);
--> statement-breakpoint
ALTER TABLE `interview_sessions` ADD `provider_session_id` text;
--> statement-breakpoint
UPDATE `interview_sessions`
SET `provider` = 'openclaw',
	`provider_session_id` = (
		SELECT `legacy`.`provider_session_id`
		FROM `__codex_legacy_provider_sessions` AS `legacy`
		WHERE `legacy`.`session_id` = `interview_sessions`.`session_id`
	)
WHERE `session_id` IN (SELECT `session_id` FROM `__codex_legacy_provider_sessions`);
--> statement-breakpoint
UPDATE `interview_sessions`
SET `stage_id` = NULL
WHERE `session_type` = 'story' AND `story_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `interview_sessions_provider_session_id_uq`
ON `interview_sessions` (`provider`, `provider_session_id`)
WHERE `provider_session_id` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `__codex_user_account_backfill`;
--> statement-breakpoint
DROP TABLE `__codex_legacy_provider_sessions`;
