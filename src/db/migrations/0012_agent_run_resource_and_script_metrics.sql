ALTER TABLE `agent_runs` ADD `resource_version` text;
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `script_call_count` integer DEFAULT 0 NOT NULL;
