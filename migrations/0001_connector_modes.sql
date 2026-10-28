ALTER TABLE "connections" ADD COLUMN "mode" text DEFAULT 'demo' NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "status_detail" text;