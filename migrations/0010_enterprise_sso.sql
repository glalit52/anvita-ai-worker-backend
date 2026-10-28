CREATE TABLE "saml_replays" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_configs" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"entry_point" text,
	"idp_issuer" text,
	"idp_cert" text,
	"domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"enforced" boolean DEFAULT false NOT NULL,
	"allow_jit" boolean DEFAULT true NOT NULL,
	"default_role" text DEFAULT 'member' NOT NULL,
	"scim_token_hash" text,
	"scim_token_hint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "sso_configs" ADD CONSTRAINT "sso_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anvita_tenant') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON sso_configs, saml_replays TO anvita_tenant;
    ALTER TABLE sso_configs ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON sso_configs;
    CREATE POLICY tenant_isolation ON sso_configs TO anvita_tenant USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
  END IF;
END $$;
