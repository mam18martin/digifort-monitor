import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface MigrationConnection {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

const migrationId = '001_inventory';

/** Caller supplies a dedicated connection. Never called by API startup. */
export async function migrate(db: MigrationConnection, direction: 'up' | 'down'): Promise<void> {
  if (direction !== 'up' && direction !== 'down') throw new Error('Invalid migration direction');
  const base = new URL('../../migrations/', import.meta.url);
  const [up, down] = await Promise.all([
    readFile(new URL(`${migrationId}.up.sql`, base), 'utf8'),
    readFile(new URL(`${migrationId}.down.sql`, base), 'utf8'),
  ]);
  const checksum = createHash('sha256').update(up).update('\0').update(down).digest('hex');
  await db.exec('BEGIN');
  try {
    await db.exec("SET LOCAL search_path = public; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'");
    await db.exec('SELECT pg_advisory_xact_lock(73431001)');
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await db.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id');
    if (result.rows.some(row => row.id !== migrationId || row.checksum !== checksum)) {
      throw new Error('Migration history does not match the packaged migration');
    }
    const applied = result.rows.length === 1;
    if (direction === 'up' && !applied) {
      await db.exec(up);
      await db.query('INSERT INTO schema_migrations(id, checksum) VALUES ($1, $2)', [migrationId, checksum]);
    } else if (direction === 'down' && applied) {
      await db.exec(down);
      await db.query('DELETE FROM schema_migrations WHERE id = $1', [migrationId]);
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
