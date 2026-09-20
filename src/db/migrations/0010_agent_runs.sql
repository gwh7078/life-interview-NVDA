CREATE TABLE `agent_runs` (
  `run_id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `agent_type` text NOT NULL,
  `task_type` text NOT NULL,
  `resource_type` text NOT NULL,
  `resource_id` text NOT NULL,
  `runtime` text DEFAULT 'nemoclaw-openclaw' NOT NULL,
  `model` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `started_at` text,
  `completed_at` text,
  `latency_ms` integer,
  `error_code` text,
  `result_json` text,
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE cascade ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_runs_user_id_idx` ON `agent_runs` (`user_id`);
--> statement-breakpoint
CREATE INDEX `agent_runs_user_status_idx` ON `agent_runs` (`user_id`,`status`);
--> statement-breakpoint
CREATE INDEX `agent_runs_resource_idx` ON `agent_runs` (`user_id`,`resource_type`,`resource_id`);
