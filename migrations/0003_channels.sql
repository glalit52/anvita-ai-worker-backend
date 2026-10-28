CREATE TABLE "channel_events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD COLUMN "thread_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "external_ref" text;--> statement-breakpoint
CREATE INDEX "connections_external_idx" ON "connections" USING btree ("app_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_external_uq" ON "threads" USING btree ("workspace_id","external_ref");