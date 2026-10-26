-- Explicit owner maintenance after approving migration 005. Creates no roles or passwords.
-- psql variables: expected_database, manager_role, reader_role. Do not run against an unapproved target.
\set ON_ERROR_STOP on
SELECT current_database()=:'expected_database' AS correct_database \gset
\if :correct_database
\else
  \echo 'Unexpected database; no grants applied.'
  \quit
\endif
SELECT count(*)=2 AND bool_and(NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) AS safe_roles
 FROM pg_roles WHERE rolname IN (:'manager_role',:'reader_role') \gset
\if :safe_roles
\else
  \echo 'Provision two distinct nonprivileged application roles first.'
  \quit
\endif
BEGIN;
GRANT CONNECT ON DATABASE :"expected_database" TO :"manager_role", :"reader_role";
GRANT USAGE ON SCHEMA public TO :"manager_role", :"reader_role";
GRANT SELECT,INSERT,UPDATE ON digifort_servers TO :"manager_role";
GRANT SELECT,INSERT ON server_admin_events TO :"manager_role";
GRANT SELECT(id,username,role,enabled,auth_version) ON app_users TO :"manager_role";
GRANT SELECT ON digifort_servers,app_users TO :"reader_role";
GRANT EXECUTE ON FUNCTION validate_server_admin_update(),protect_server_admin_events() TO :"manager_role";
ALTER ROLE :"reader_role" SET default_transaction_read_only=on;
COMMIT;
