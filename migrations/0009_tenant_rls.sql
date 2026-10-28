-- Row-level security for tenant isolation (defense in depth).
-- Workspace-scoped API requests run as the restricted role `anvita_tenant` with
-- `app.workspace_id` set for their transaction; every table carrying a workspace_id only shows and
-- accepts that workspace's rows. The table owner (migrations, auth lookups, background jobs) is
-- unaffected because RLS isn't forced on owners.
DO $$
DECLARE
  t record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anvita_tenant') THEN
    BEGIN
      CREATE ROLE anvita_tenant NOLOGIN;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'Cannot create role anvita_tenant (needs CREATEROLE); row-level security stays off';
      RETURN;
    END;
  END IF;
  BEGIN
    EXECUTE format('GRANT anvita_tenant TO %I', current_user);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Cannot grant anvita_tenant to %: %', current_user, SQLERRM;
  END;
  GRANT USAGE ON SCHEMA public TO anvita_tenant;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anvita_tenant;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anvita_tenant;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anvita_tenant;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO anvita_tenant;

  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.table_name);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I TO anvita_tenant USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true))$p$, t.table_name);
  END LOOP;

  ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON workspaces;
  CREATE POLICY tenant_isolation ON workspaces TO anvita_tenant USING (id = current_setting('app.workspace_id', true)) WITH CHECK (id = current_setting('app.workspace_id', true));

  -- People: only members of the current workspace are visible.
  ALTER TABLE users ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON users;
  CREATE POLICY tenant_isolation ON users TO anvita_tenant
    USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.workspace_id = current_setting('app.workspace_id', true)))
    WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.workspace_id = current_setting('app.workspace_id', true)));
END $$;
