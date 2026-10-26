import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface MigrationConnection {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const migrationIds = ['001_inventory', '002_sync_observations', '003_identity_review', '004_description_identity', '005_apicamstat_management'] as const;
type MigrationId = typeof migrationIds[number];

/** Caller supplies a dedicated connection. Never called by API startup. */
export async function migrate(db: MigrationConnection, direction: 'up' | 'down', through: MigrationId = '005_apicamstat_management'): Promise<void> {
  if (direction !== 'up' && direction !== 'down') throw new Error('Invalid migration direction');
  const base = new URL('../../migrations/', import.meta.url);
  const limit = migrationIds.indexOf(through);
  if (limit < 0) throw new Error('Unknown migration target');
  const migrations = await Promise.all(migrationIds.slice(0, limit + 1).map(async id => {
    const [up, down] = await Promise.all([
      readFile(new URL(`${id}.up.sql`, base), 'utf8'),
      readFile(new URL(`${id}.down.sql`, base), 'utf8'),
    ]);
    return { id, up, down, checksum: createHash('sha256').update(up).update('\0').update(down).digest('hex') };
  }));
  await db.exec('BEGIN');
  try {
    await db.exec("SET LOCAL search_path = public; SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '30s'");
    await db.exec('SELECT pg_advisory_xact_lock(73431001)');
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await db.query<{ id: string; checksum: string }>('SELECT id, checksum FROM schema_migrations ORDER BY id');
    if (result.rows.length > migrations.length || result.rows.some((row, index) =>
      row.id !== migrations[index].id || row.checksum !== migrations[index].checksum)) {
      throw new Error('Migration history does not match the packaged migrations');
    }
    if (direction === 'up') {
      for (const migration of migrations.slice(result.rows.length)) {
        await db.exec(migration.up);
        await db.query('INSERT INTO schema_migrations(id, checksum) VALUES ($1, $2)', [migration.id, migration.checksum]);
      }
    } else {
      // All packaged tables are removed atomically; this is not a partial source downgrade.
      await db.exec("SET LOCAL digifort.full_schema_rollback='yes'");
      for (const migration of migrations.slice(0, result.rows.length).reverse()) {
        await db.exec(migration.down);
        await db.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
      }
    }
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
