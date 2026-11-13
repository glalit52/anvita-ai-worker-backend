CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"number" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal" real NOT NULL,
	"cgst" real DEFAULT 0 NOT NULL,
	"sgst" real DEFAULT 0 NOT NULL,
	"igst" real DEFAULT 0 NOT NULL,
	"total" real NOT NULL,
	"lines" jsonb NOT NULL,
	"seller" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"provider_ref" text,
	"issued_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_plans" (
	"key" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'starter' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"provider" text DEFAULT 'free' NOT NULL,
	"provider_ref" text,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"pending_plan" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_provider_ref_uq" ON "invoices" USING btree ("provider_ref");--> statement-breakpoint
CREATE INDEX "invoices_ws_idx" ON "invoices" USING btree ("workspace_id","issued_at");--> statement-breakpoint
CREATE INDEX "subscriptions_provider_ref_idx" ON "subscriptions" USING btree ("provider","provider_ref");--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq;--> statement-breakpoint
-- Existing workspaces keep their plan (Business by default) as an active subscription.
INSERT INTO subscriptions (workspace_id, plan, interval, status, provider, current_period_start, current_period_end)
SELECT id, lower(plan), 'month', 'active', 'manual', now(), coalesce(renews_at, now() + interval '30 days') FROM workspaces
ON CONFLICT (workspace_id) DO NOTHING;--> statement-breakpoint
UPDATE workspaces SET plan = lower(plan);--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anvita_tenant') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON subscriptions, invoices, provider_plans TO anvita_tenant;
    GRANT USAGE, SELECT ON SEQUENCE invoice_number_seq TO anvita_tenant;
    ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON subscriptions;
    CREATE POLICY tenant_isolation ON subscriptions TO anvita_tenant USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
    ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON invoices;
    CREATE POLICY tenant_isolation ON invoices TO anvita_tenant USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END $$;
