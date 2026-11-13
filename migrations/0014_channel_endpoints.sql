CREATE TABLE "channel_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"worker_id" text,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_endpoints" ADD CONSTRAINT "channel_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_endpoints_key_uq" ON "channel_endpoints" USING btree ("key");--> statement-breakpoint
CREATE INDEX "channel_endpoints_ws_idx" ON "channel_endpoints" USING btree ("workspace_id");--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anvita_tenant') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON channel_endpoints TO anvita_tenant;
    ALTER TABLE channel_endpoints ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON channel_endpoints;
    CREATE POLICY tenant_isolation ON channel_endpoints TO anvita_tenant USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END $$;
