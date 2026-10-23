-- Prepared only. The approved cluster administrator grants temporary privileges.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$
BEGIN
  IF current_setting('digifort.expected_database', true) IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'Explicit database confirmation required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname='btree_gist') THEN
    RAISE EXCEPTION 'Extension already installed; inspect owner, version and schema';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extension_versions WHERE name='btree_gist' AND version='1.7' AND trusted) THEN
    RAISE EXCEPTION 'Reviewed trusted extension version unavailable';
  END IF;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO monitor_admin', current_database());
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO monitor_admin;
SET LOCAL ROLE monitor_admin;
CREATE EXTENSION btree_gist WITH SCHEMA public VERSION '1.7';
RESET ROLE;
REVOKE ALL ON SCHEMA public FROM monitor_admin;
DO $$ BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM monitor_admin', current_database());
END $$;
COMMIT;
