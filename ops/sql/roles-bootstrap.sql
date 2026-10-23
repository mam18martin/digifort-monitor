-- Prepared only. Execute as the approved cluster administrator, never at startup.
-- Set digifort.expected_database explicitly before executing this script.
BEGIN;
DO $$
BEGIN
  IF current_setting('digifort.expected_database', true) IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'Explicit database confirmation required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('monitor_owner','monitor_migrator','monitor_app','monitor_admin')) THEN
    RAISE EXCEPTION 'Prepared role names already exist; manual review required';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public') THEN
    RAISE EXCEPTION 'Bootstrap requires the reviewed empty public schema';
  END IF;
END $$;

CREATE ROLE monitor_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE monitor_migrator NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE monitor_app NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE monitor_admin NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT monitor_owner TO monitor_migrator WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;

-- This database is dedicated to this application. Shared databases need review.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO monitor_owner;
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO monitor_app, monitor_migrator, monitor_admin', current_database());
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE monitor_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
-- The application currently needs CONNECT and SELECT 1, no business tables.
-- Login and private credentials must be provisioned separately after approval.
COMMIT;
