import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { databaseSuite } from './database-suite.ts';
import { migrate } from '../src/database/migrations.ts';

test('initial schema on isolated embedded PostgreSQL 17', async t => {
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    const version = await db.query<{ server_version: string }>('SHOW server_version');
    assert.ok(String(version.rows[0].server_version).startsWith('17.'));
    await db.exec('CREATE EXTENSION btree_gist');
    await databaseSuite(t, db);
  } finally { await db.close(); }
});

test('a failed migration rolls back all DDL and its ledger atomically', async () => {
  const db = new PGlite({ extensions: { btree_gist } });
  try {
    await db.exec('CREATE EXTENSION btree_gist');
    await assert.rejects(migrate({
      query: (sql, params) => db.query(sql, params),
      exec: sql => db.exec(sql.startsWith('-- Requires') ? sql + '\nSELECT * FROM deliberately_missing_test_table;' : sql),
    }, 'up'));
    const tables = await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.deepEqual(tables.rows, []);
    await migrate(db,'up');
    await migrate(db,'down');
  } finally { await db.close(); }
});
