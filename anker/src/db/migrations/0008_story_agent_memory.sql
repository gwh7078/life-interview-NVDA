ALTER TABLE stories ADD COLUMN agent_memory TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE stories SET agent_memory = summary WHERE agent_memory = '';
