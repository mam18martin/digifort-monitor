import pg from 'pg';
import { migrate } from './migrations.js';
import { selectMigrationOwner, validOwnerRole } from './migration-role.js';

// Deliberately does not fall back to PG*, DATABASE_URL or Compose's .env.
const connectionString = process.env.MIGRATION_DATABASE_URL;
const expectedDatabase = process.env.MIGRATION_EXPECTED_DATABASE;
const ownerRole = process.env.MIGRATION_OWNER_ROLE;
const direction = process.argv[2];
if (!connectionString || !expectedDatabase || !validOwnerRole(ownerRole) || !['up', 'down'].includes(direction ?? '')
  || (direction === 'down' && process.env.MIGRATION_ALLOW_DOWN !== 'yes')) {
  console.error('Configuración de migración incompleta o rollback no autorizado.');
  process.exitCode = 1;
} else {
  let client: pg.Client | undefined;
  try {
    client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    const result = await client.query<{ name: string }>('SELECT current_database() AS name');
    if (result.rows[0].name !== expectedDatabase) throw new Error('Unexpected database');
    const db = {
      exec: sql => client!.query(sql),
      query: (sql, params) => client!.query(sql, params),
    } satisfies import('./migrations.js').MigrationConnection;
    await selectMigrationOwner(db, ownerRole);
    await migrate(db, direction as 'up' | 'down');
    console.log('Migración completada.');
  } catch {
    // Driver errors can contain SQL detail, addresses or authentication material.
    console.error('No se pudo completar la migración; revisar el destino y los requisitos sin publicar datos privados.');
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}
