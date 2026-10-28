ALTER TABLE "run_steps" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_node_id" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "engine" text DEFAULT 'graph' NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" USING btree ("parent_run_id");