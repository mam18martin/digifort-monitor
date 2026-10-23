import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { migrate } from '../src/database/migrations.ts';
import { selectMigrationOwner, validOwnerRole } from '../src/database/migration-role.ts';

test('prepared role separation on disposable embedded PostgreSQL 17 only', async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  const bootstrap = await readFile(new URL('../../../ops/sql/roles-bootstrap.sql', import.meta.url), 'utf8');
  const extension = await readFile(new URL('../../../ops/sql/install-extension.sql', import.meta.url), 'utf8');
  const permissionDenied = (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
  try {
    assert.equal(validOwnerRole('owner; RESET ROLE;'), false);
    await assert.rejects(db.exec(bootstrap), /Explicit database confirmation/);
    await db.exec('ROLLBACK');
    await db.exec("SELECT set_config('digifort.expected_database',current_database(),false)");
    await db.exec(bootstrap);
    await db.exec(extension);
    const admin = await db.query<{ can_create: boolean }>("SELECT has_database_privilege('monitor_admin',current_database(),'CREATE') AS can_create");
    assert.equal(admin.rows[0].can_create, false);
    await assert.rejects(selectMigrationOwner(db, 'monitor_owner'), /Elevated maintenance login/);

    // Session authorization simulates the isolated login without setting passwords.
    await db.exec('SET SESSION AUTHORIZATION monitor_migrator');
    await assert.rejects(db.exec('CREATE TABLE public.not_allowed(id integer)'), permissionDenied);
    await selectMigrationOwner(db, 'monitor_owner');
    await migrate(db, 'up');
    const owner = await db.query<{ owner: string }>("SELECT tableowner AS owner FROM pg_tables WHERE schemaname='public' AND tablename='cameras'");
    assert.equal(owner.rows[0].owner, 'monitor_owner');
    await db.exec('RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION monitor_app');
    assert.equal((await db.query<{ value: number }>('SELECT 1 AS value')).rows[0].value, 1);
    await assert.rejects(db.query('SELECT * FROM public.cameras'), permissionDenied);
    await assert.rejects(db.exec('CREATE TABLE public.denied(id integer)'), permissionDenied);
    await assert.rejects(db.exec('SET ROLE monitor_owner'), permissionDenied);
    await db.exec('RESET SESSION AUTHORIZATION; SET SESSION AUTHORIZATION monitor_migrator');
    await selectMigrationOwner(db, 'monitor_owner');
    await migrate(db, 'down');
  } finally { await db.close(); }
});
