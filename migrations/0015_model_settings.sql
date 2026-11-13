ALTER TABLE "workspaces" ADD COLUMN "model_key_enc" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "model_key_hint" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "model_key_added_at" timestamp with time zone;