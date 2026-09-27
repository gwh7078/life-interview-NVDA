CREATE TABLE `interview_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`openclaw_session_key` text NOT NULL,
	`user_id` text NOT NULL,
	`stage_id` text,
	`story_id` text,
	`session_type` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`closeout_status` text DEFAULT 'pending' NOT NULL,
	`session_summary` text,
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
CREATE INDEX `interview_sessions_user_id_idx` ON `interview_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `interview_sessions_story_id_idx` ON `interview_sessions` (`story_id`);--> statement-breakpoint
CREATE INDEX `interview_sessions_stage_id_idx` ON `interview_sessions` (`stage_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `interview_sessions_openclaw_session_key_uq` ON `interview_sessions` (`openclaw_session_key`);--> statement-breakpoint
CREATE INDEX `interview_sessions_status_idx` ON `interview_sessions` (`status`);--> statement-breakpoint
CREATE TABLE `life_stages` (
	`stage_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`start_date` text,
	`end_date` text,
	`date_precision` text,
	`summary` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_source_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `life_stages_user_id_idx` ON `life_stages` (`user_id`);--> statement-breakpoint
CREATE INDEX `life_stages_user_sort_order_idx` ON `life_stages` (`user_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `memoir_documents` (
	`document_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`version_number` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "memoir_documents_version_number_check" CHECK("memoir_documents"."version_number" >= 1)
);
--> statement-breakpoint
CREATE INDEX `memoir_documents_user_id_idx` ON `memoir_documents` (`user_id`);--> statement-breakpoint
CREATE INDEX `memoir_documents_scope_idx` ON `memoir_documents` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `stories` (
	`story_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`title` text NOT NULL,
	`short_summary` text,
	`story_state_json` text DEFAULT '{}' NOT NULL,
	`completeness` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`created_source_session_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`stage_id`) REFERENCES `life_stages`(`stage_id`) ON UPDATE cascade ON DELETE cascade,
	CONSTRAINT "stories_completeness_range_check" CHECK("stories"."completeness" >= 0 AND "stories"."completeness" <= 100)
);
--> statement-breakpoint
CREATE INDEX `stories_user_id_idx` ON `stories` (`user_id`);--> statement-breakpoint
CREATE INDEX `stories_stage_id_idx` ON `stories` (`stage_id`);--> statement-breakpoint
CREATE INDEX `stories_user_stage_idx` ON `stories` (`user_id`,`stage_id`);--> statement-breakpoint
CREATE INDEX `stories_status_idx` ON `stories` (`status`);--> statement-breakpoint
CREATE TABLE `story_candidates` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_story_id` text,
	`suggested_stage_id` text,
	`suggested_title` text NOT NULL,
	`clue_summary` text,
	`source_refs_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_story_id` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`source_session_id`) REFERENCES `interview_sessions`(`session_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`source_story_id`) REFERENCES `stories`(`story_id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`suggested_stage_id`) REFERENCES `life_stages`(`stage_id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`created_story_id`) REFERENCES `stories`(`story_id`) ON UPDATE cascade ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `story_candidates_user_id_idx` ON `story_candidates` (`user_id`);--> statement-breakpoint
CREATE INDEX `story_candidates_status_idx` ON `story_candidates` (`status`);--> statement-breakpoint
CREATE INDEX `story_candidates_source_session_id_idx` ON `story_candidates` (`source_session_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`nickname` text,
	`phone` text,
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `users_email_idx` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_phone_idx` ON `users` (`phone`);