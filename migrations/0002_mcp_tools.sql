ALTER TABLE "mcp_servers" ADD COLUMN "tool_defs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "last_checked_at" timestamp with time zone;