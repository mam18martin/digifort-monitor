import pg from 'pg';
import type { MigrationConnection } from './migrations.js';

export function validOwnerRole(role: string | undefined): role is string {
  return typeof role === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(role);
}

/** Session-only role selection. No persistent GRANT/ALTER ROLE operations. */
export async function selectMigrationOwner(db: MigrationConnection, role: string): Promise<void> {
  if (!validOwnerRole(role)) throw new Error('Explicit migration owner required');
  const result = await db.query<{
    rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean;
  }>('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=session_user');
  if (result.rows.length !== 1 || Object.values(result.rows[0]).some(Boolean)) {
    throw new Error('Elevated maintenance login is prohibited');
  }
  const owner = await db.query<{ privileged: boolean; rolcanlogin: boolean }>(
    'SELECT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS privileged, rolcanlogin FROM pg_roles WHERE rolname=$1', [role],
  );
  if (owner.rows.length !== 1 || owner.rows[0].privileged || owner.rows[0].rolcanlogin) {
    throw new Error('Migration owner must be a nonprivileged nonlogin role');
  }
  await db.exec(`SET ROLE ${pg.escapeIdentifier(role)}`);
}
