CREATE TABLE `retriever_index_jobs` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`content_hash` text,
	`retriever_job_id` text,
	`retriever_document_id` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`indexed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `interview_sessions`(`session_id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `retriever_index_jobs_user_status_idx` ON `retriever_index_jobs` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `retriever_index_jobs_status_updated_idx` ON `retriever_index_jobs` (`status`,`updated_at`);
