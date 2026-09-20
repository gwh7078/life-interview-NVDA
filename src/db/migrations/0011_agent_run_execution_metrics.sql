ALTER TABLE `agent_runs` ADD `mode` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `skill` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `skill_version` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `provider` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `context_version` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `schema_version` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `repair_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `tool_call_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `format_repair_used` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `input_hash` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `output_hash` text;
