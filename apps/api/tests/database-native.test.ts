import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseSuite } from './database-suite.ts';
import { migrate } from '../src/database/migrations.ts';
import type { MigrationConnection } from '../src/database/migrations.ts';

const enabled = process.env.RUN_NATIVE_DB_TESTS === '1';
test('initial schema on explicitly isolated native PostgreSQL 17', { skip: !enabled }, async t => {
  // No use of PG*, DATABASE_URL or the application's Compose environment.
  const host = process.env.TEST_POSTGRES_HOST;
  const database = process.env.TEST_POSTGRES_DATABASE;
  assert.ok(host && database === 'digifort_test_isolated', 'Explicit isolated test target required');
  const options = { host, database, user: 'postgres', port: 5432, password: '', connectionTimeoutMillis: 5000 };
  const client = new pg.Client(options);
  const adapt = (connection: pg.Client): MigrationConnection => ({
    exec: sql => connection.query(sql), query: (sql, params) => connection.query(sql, params),
  });
  const hasCode = (code: string) => (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === code;
  const waitForBlock = async (pid: number) => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const result = await client.query<{ blocked: boolean }>(
        'SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked', [pid],
      );
      if (result.rows[0].blocked) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('Expected competing connection to wait for the held database lock');
  };
  const competitor = async () => {
    const connection = new pg.Client(options);
    await connection.connect();
    await connection.query("SET lock_timeout='3s'; SET statement_timeout='5s'");
    const result = await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return { connection, pid: result.rows[0].pid };
  };
  try {
    await client.connect();
    const version = await client.query('SHOW server_version');
    assert.ok(String(version.rows[0].server_version).startsWith('17.'));
    const existing = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'");
    assert.equal(existing.rows[0].n, 0, 'Native tests require an empty disposable database');
    const db = adapt(client);

    await t.test('missing btree_gist fails atomically before prerequisites are installed', async () => {
      const extension = await client.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='btree_gist'");
      assert.equal(extension.rows[0].n, 0, 'Test requires a fresh isolated database');
      await assert.rejects(migrate(db, 'up'), hasCode('42704'));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'")).rows[0].n, 0);
    });
    await client.query('CREATE EXTENSION btree_gist');
    const extension = await client.query("SELECT extversion FROM pg_extension WHERE extname='btree_gist'");
    assert.ok(extension.rows[0].extversion);
    await databaseSuite(t, db);

    await t.test('native failed DDL restores tables, functions and migration history atomically', async () => {
      await assert.rejects(migrate({
        query: (sql, params) => client.query(sql, params),
        exec: sql => client.query(sql.startsWith('-- Requires')
          ? sql + '\nSELECT * FROM deliberately_missing_synthetic_table;' : sql),
      }, 'up'), hasCode('42P01'));
      assert.equal((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'")).rows[0].n, 0);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname='initialize_camera_state'")).rows[0].n, 0);
    });

    try {
      await t.test('migration advisory lock serializes concurrent runners', async () => {
        const other = await competitor();
        let pending: Promise<void> | undefined;
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(73431001)');
          pending = migrate(adapt(other.connection), 'up');
          // Attach a handler immediately; the original promise is still awaited below.
          void pending.catch(() => {});
          await waitForBlock(other.pid);
          await client.query('COMMIT');
          await Promise.all([pending, migrate(db, 'up')]);
          assert.equal((await client.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
        } finally {
          await client.query('ROLLBACK');
          await pending?.catch(() => {});
          await other.connection.end();
        }
      });

      for (const commit of [true, false]) {
        await t.test(`camera_code race waits for ${commit ? 'commit and rejects duplicate' : 'rollback and accepts retry'}`, async () => {
          const other = await competitor();
          let pending: Promise<{ code: string | null }> | undefined;
          const number = commit ? '9501' : '9502';
          const insert = 'INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,\'F\')';
          try {
            await client.query('BEGIN');
            await client.query(insert, [number]);
            pending = other.connection.query(insert, [number]).then(() => ({ code: null }), error => ({ code: error.code }));
            await waitForBlock(other.pid);
            await client.query(commit ? 'COMMIT' : 'ROLLBACK');
            assert.equal((await pending).code, commit ? '23505' : null);
            assert.equal((await client.query('SELECT count(*)::int AS n FROM cameras WHERE camera_code=$1', [number + 'F'])).rows[0].n, 1);
          } finally {
            await client.query('ROLLBACK');
            await pending;
            await other.connection.end();
          }
        });
      }

      await t.test('temporal exclusion waits for a concurrent binding and rejects overlap', async () => {
        const other = await competitor();
        let pending: Promise<{ code: string | null }> | undefined;
        try {
          const first = await client.query('INSERT INTO cameras DEFAULT VALUES RETURNING id');
          const second = await client.query('INSERT INTO cameras DEFAULT VALUES RETURNING id');
          const server = await client.query(`INSERT INTO digifort_servers(config_key,name,endpoint_origin)
            VALUES ('native-test','Test','https://digifort.invalid') RETURNING id`);
          const insert = `INSERT INTO camera_bindings(camera_id,server_id,external_name,identity_generation)
            VALUES ($1,$2,'concurrent-synthetic',$3)`;
          await client.query('BEGIN');
          await client.query(insert, [first.rows[0].id, server.rows[0].id, 1]);
          pending = other.connection.query(insert, [second.rows[0].id, server.rows[0].id, 2])
            .then(() => ({ code: null }), error => ({ code: error.code }));
          await waitForBlock(other.pid);
          await client.query('COMMIT');
          assert.equal((await pending).code, '23P01');
          assert.equal((await client.query('SELECT count(*)::int AS n FROM camera_bindings')).rows[0].n, 1);
        } finally {
          await client.query('ROLLBACK');
          await pending;
          await other.connection.end();
        }
      });
    } finally { await migrate(db, 'down'); }
  } finally { await client.end(); }
});
