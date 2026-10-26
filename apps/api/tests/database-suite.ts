import {migrationIds} from '../src/database/migrations.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { snapshotWriterSuite } from './snapshot-writer-suite.ts';
import { syncObservationSuite } from './sync-observation-suite.ts';
import { migrate } from '../src/database/migrations.ts';
import type { MigrationConnection } from '../src/database/migrations.ts';

/** Shared by embedded PostgreSQL 17 and the opt-in isolated native database. */
export async function databaseSuite(t: TestContext, db: MigrationConnection): Promise<void> {
  const sql = (text: string, params?: unknown[]) => db.query(text, params);
  const reject = (text: string, params: unknown[], code: string) => assert.rejects(sql(text, params),
    (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === code);
  const camera = async (number: string | null = null, type: string | null = null) => {
    const { rows } = await sql('INSERT INTO cameras(camera_number, camera_type_code) VALUES ($1, $2) RETURNING id', [number, type]);
    return rows[0].id as string;
  };
  const server = async () => {
    const { rows } = await sql(`INSERT INTO digifort_servers(config_key, name, endpoint_origin, credential_ref)
      VALUES ($1, 'Servidor de ensayo', 'https://digifort.invalid', 'test_secret_reference') RETURNING id`, [randomUUID()]);
    return rows[0].id as string;
  };
  const binding = async (cam: string, srv: string, name: string, from: string, to: string | null = null, generation = 1) => {
    const { rows } = await sql(`INSERT INTO camera_bindings(camera_id, server_id, external_name, valid_from, valid_to, identity_generation)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [cam, srv, name, from, to, generation]);
    return rows[0].id as string;
  };
  const start = '2026-01-01T00:00:00Z';
  const middle = '2026-01-02T00:00:00Z';
  const end = '2026-01-03T00:00:00Z';

  await t.test('upgrade from 001 preserves data and checksum; failed 002 is atomic', async () => {
    await migrate(db, 'up', '001_inventory');
    const checksum = (await sql("SELECT checksum FROM schema_migrations WHERE id='001_inventory'")).rows[0].checksum;
    assert.equal(checksum, 'ccc33e8e1c618656a0e1199ccdbc6c4781073638567d2b152e64ddccd1899a8d');
    await sql("INSERT INTO nodes(code,name) VALUES ('upgrade-synthetic','Nodo previo')");
    await assert.rejects(migrate({
      query: (text, params) => db.query(text, params),
      exec: text => db.exec(text.startsWith('-- Tracking only:') ? text + '\nSELECT * FROM deliberately_missing_upgrade_table;' : text),
    }, 'up'));
    assert.equal((await sql('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 1);
    assert.equal((await sql("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public' AND tablename='sync_runs'")).rows[0].n, 0);
    await migrate(db, 'up');
    assert.equal((await sql("SELECT checksum FROM schema_migrations WHERE id='001_inventory'")).rows[0].checksum, checksum);
    assert.equal((await sql("SELECT name FROM nodes WHERE code='upgrade-synthetic'")).rows[0].name, 'Nodo previo');
  });

  await t.test('migration up is idempotent and seeds the extensible catalog', async () => {
    await migrate(db, 'up');
    await migrate(db, 'up');
    assert.deepEqual((await sql('SELECT code, name FROM camera_types ORDER BY code')).rows, [
      { code: 'D', name: 'Domo' }, { code: 'F', name: 'Fija' }, { code: 'P', name: 'Punto Seguro' },
    ]);
    assert.equal((await sql('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, migrationIds.length);
  });

  await t.test('complete codes are unique; numeric parts, leading zeros and NULLs are preserved', async () => {
    await camera('0042', 'F');
    await camera('0042', 'D');
    await camera('42', 'F');
    await camera();
    await camera();
    assert.deepEqual((await sql('SELECT camera_code FROM cameras WHERE camera_code IS NOT NULL ORDER BY camera_code')).rows,
      [{ camera_code: '0042D' }, { camera_code: '0042F' }, { camera_code: '42F' }]);
    assert.equal((await sql('SELECT count(*)::int AS n FROM cameras WHERE camera_code IS NULL')).rows[0].n, 2);
    await reject('INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,$2)', ['0042', 'F'], '23505');
    for (const values of [[null, 'F'], ['42', null], ['', 'F'], ['4x', 'F']]) {
      await reject('INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,$2)', values, '23514');
    }
    const types = await sql(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name='cameras' AND column_name IN ('id','camera_number','camera_type_code') ORDER BY column_name`);
    assert.deepEqual(types.rows, [
      { column_name: 'camera_number', data_type: 'text' }, { column_name: 'camera_type_code', data_type: 'text' },
      { column_name: 'id', data_type: 'uuid' },
    ]);
  });

  await t.test('new letters can be added; unknown and disabled types cannot be assigned', async () => {
    await reject('INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,$2)', ['77', 'X'], '23514');
    await sql("INSERT INTO camera_types(code,name) VALUES ('X','Tipo de ensayo')");
    const id = await camera('77', 'X');
    assert.equal((await sql('SELECT camera_code FROM cameras WHERE id=$1', [id])).rows[0].camera_code, '77X');
    await sql("UPDATE camera_types SET enabled=false WHERE code='X'");
    await reject('INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,$2)', ['78', 'X'], '23514');
    await sql("UPDATE cameras SET identity_review='confirmed' WHERE id=$1", [id]);
    await reject("INSERT INTO camera_types(code,name) VALUES ('xx','Invalid')", [], '23514');
    await reject("DELETE FROM camera_types WHERE code='X'", [], '23503');
  });

  await t.test('code corrections, physical deletion and UUID reassignment are blocked conservatively', async () => {
    const id = await camera('80', 'F');
    await reject('UPDATE cameras SET camera_number=$1 WHERE id=$2', ['81', id], '23514');
    await reject('UPDATE cameras SET camera_number=NULL,camera_type_code=NULL WHERE id=$1', [id], '23514');
    await reject('UPDATE cameras SET id=$1 WHERE id=$2', [randomUUID(), id], '23514');
    await reject('DELETE FROM cameras WHERE id=$1', [id], '23514');
    await sql('UPDATE cameras SET retired_at=now() WHERE id=$1', [id]);
    await reject('INSERT INTO cameras(camera_number,camera_type_code) VALUES ($1,$2)', ['80', 'F'], '23505');
    const provisional = await camera();
    await sql("UPDATE cameras SET camera_number='81',camera_type_code='F' WHERE id=$1", [provisional]);
  });

  await t.test('origin and references store no authenticated URLs and enforce parent relationships', async () => {
    await reject(`INSERT INTO digifort_servers(config_key,name,endpoint_origin) VALUES ('invalid','Test',$1)`,
      ['https://digifort.invalid?AuthPass=synthetic'], '23514');
    await reject(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,credential_ref)
      VALUES ('invalid-ref','Test','https://digifort.invalid',$1)`, ['https://secret.invalid/token'], '23514');
    await reject(`INSERT INTO camera_bindings(camera_id,server_id,external_name) VALUES ($1,$2,'synthetic')`,
      [randomUUID(), randomUUID()], '23503');
    const columns = (await sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name<>'app_users'`)).rows;
    assert.ok(!columns.some(row => ['password', 'username', 'token', 'auth_pass', 'auth_user'].includes(String(row.column_name))));
  });

  await t.test('temporal bindings reject overlap, admit adjacency and preserve Name case and scope', async () => {
    const a = await camera(); const b = await camera(); const srv = await server(); const other = await server();
    const first = await binding(a, srv, 'SyntheticName', start, middle);
    await binding(a, srv, 'RenamedSynthetic', middle);
    await reject(`INSERT INTO camera_bindings(camera_id,server_id,external_name,valid_from,valid_to)
      VALUES ($1,$2,'overlap',$3,$4)`, [a, other, start, end], '23P01');
    await reject(`INSERT INTO camera_bindings(camera_id,server_id,external_name,valid_from,identity_generation)
      VALUES ($1,$2,'SyntheticName',$3,2)`, [b, srv, start], '23P01');
    await binding(b, srv, 'syntheticname', start); // Different case is a distinct lookup key.
    await binding(await camera(), other, 'SyntheticName', start); // Server scopes lookup names.
    await binding(await camera(), srv, 'SyntheticName', middle, null, 2); // Adjacent reuse is a new binding, never an identity merge.
    const externalA = await camera(); const externalB = await camera();
    await sql(`INSERT INTO camera_bindings(camera_id,server_id,external_name,external_id,valid_from)
      VALUES ($1,$2,'external-a','synthetic-external-id',$3)`,[externalA,srv,start]);
    await reject(`INSERT INTO camera_bindings(camera_id,server_id,external_name,external_id,valid_from)
      VALUES ($1,$2,'external-b','synthetic-external-id',$3)`,[externalB,srv,start],'23P01');
    await reject('UPDATE camera_bindings SET valid_to=NULL WHERE id=$1', [first], '23514');
    await reject('UPDATE camera_bindings SET external_name=$1 WHERE id=$2', ['rewritten', first], '23514');
    await reject('DELETE FROM camera_bindings WHERE id=$1', [first], '23514');
    await reject('DELETE FROM digifort_servers WHERE id=$1', [srv], '23514');
    await reject(`INSERT INTO camera_bindings(camera_id,server_id,external_name,valid_from,valid_to)
      VALUES ($1,$2,'empty-period',$3,$3)`, [await camera(), srv, start], '23514');
  });

  await t.test('inventory versions preserve original Description, suffix and provisional candidates without merging', async () => {
    const a = await camera(); const b = await camera(); const srv = await server();
    const link = await binding(a, srv, 'inventory-synthetic', start);
    const { rows: nodes } = await sql("INSERT INTO nodes(code,name) VALUES ('test-node','Nodo de ensayo') RETURNING id");
    const insert = `INSERT INTO camera_inventory_versions(camera_id,binding_id,node_id,valid_from,first_observed_at,last_confirmed_at,
      description_original,description_text,code_candidate,code_parse_status,code_review_status,connection_address)
      VALUES ($1,$2,$3,$4,$4,$4,$5,$6,'0042X','unknown_type','pending','camera.invalid') RETURNING id`;
    const original = '0042X) Descripción sintética ) con otro separador';
    const suffix = ' Descripción sintética ) con otro separador';
    const version = (await sql(insert, [a, link, nodes[0].id, start, original, suffix])).rows[0].id;
    assert.equal((await sql('SELECT description_original,description_text FROM camera_inventory_versions WHERE id=$1', [version])).rows[0].description_original, original);
    assert.equal((await sql('SELECT description_text FROM camera_inventory_versions WHERE id=$1', [version])).rows[0].description_text, suffix);
    await reject(insert, [b, link, nodes[0].id, start, original, suffix], '23503');
    const invalidNodeCamera = await camera();
    const invalidNodeBinding = await binding(invalidNodeCamera,srv,'invalid-node-test',start);
    await reject(insert, [invalidNodeCamera, invalidNodeBinding, randomUUID(), start, original, suffix], '23503');
    await reject(insert, [a, link, nodes[0].id, middle, original, suffix], '23P01');
    await reject('UPDATE camera_inventory_versions SET description_original=$1 WHERE id=$2', ['rewritten', version], '23514');
    await reject('DELETE FROM camera_inventory_versions WHERE id=$1', [version], '23514');
    await reject('DELETE FROM nodes WHERE id=$1', [nodes[0].id], '23503');
    await sql('UPDATE camera_inventory_versions SET valid_to=$1 WHERE id=$2', [middle, version]);
    await sql(insert, [a, link, nodes[0].id, middle, null, null]);
    // A different camera can retain the same erroneous candidate and same address.
    const second = await binding(b, srv, 'another-synthetic', start);
    await sql(insert, [b, second, nodes[0].id, start, original, suffix]);
    assert.equal((await sql('SELECT count(*)::int AS n FROM cameras WHERE id IN ($1,$2)', [a,b])).rows[0].n, 2);
  });

  await t.test('inventory ranges must belong to their binding; bindings close only after dependent observations', async () => {
    const a = await camera(); const srv = await server();
    const link = await binding(a, srv, 'contained-synthetic', middle);
    const insert = `INSERT INTO camera_inventory_versions(camera_id,binding_id,valid_from,first_observed_at,last_confirmed_at)
      VALUES ($1,$2,$3,$3,$3)`;
    await reject(insert, [a,link,start], '23514');
    await sql(insert, [a,link,middle]);
    await reject('UPDATE camera_bindings SET valid_to=$1 WHERE id=$2', [end,link], '23514');
    await sql('UPDATE camera_inventory_versions SET valid_to=$1 WHERE binding_id=$2', [end,link]);
    await sql('UPDATE camera_bindings SET valid_to=$1 WHERE id=$2', [end,link]);
    await reject(insert, [a,link,end], '23514');
  });

  await t.test('current state starts unknown and all nine Active/Working combinations remain independent', async () => {
    const a = await camera(); const srv = await server(); const link = await binding(a,srv,'state-synthetic',start);
    const initial = (await sql('SELECT active,working,active_source FROM camera_current_state WHERE camera_id=$1', [a])).rows[0];
    assert.deepEqual(initial, { active: null, working: null, active_source: 'unknown' });
    for (const active of [true,false,null]) for (const working of [true,false,null]) {
      await sql(`UPDATE camera_current_state SET binding_id=$2, status_coverage='matched', status_active=$3, working=$4,
        active_observed_at=$5, working_observed_at=$6 WHERE camera_id=$1`, [a,link,active,working,active===null?null:start,working===null?null:start]);
      assert.deepEqual((await sql('SELECT active,working FROM camera_current_state WHERE camera_id=$1',[a])).rows[0], {active,working});
    }
    await sql(`UPDATE camera_current_state SET inventory_active=true,status_active=false,active_observed_at=$2 WHERE camera_id=$1`, [a,start]);
    assert.deepEqual((await sql('SELECT active,active_source FROM camera_current_state WHERE camera_id=$1',[a])).rows[0], {active:false,active_source:'status'});
    await reject(`UPDATE camera_current_state SET working=true,working_observed_at=NULL WHERE camera_id=$1`, [a], '23514');
    await reject(`UPDATE camera_current_state SET status_coverage='missing' WHERE camera_id=$1`, [a], '23514');
    await reject('UPDATE camera_current_state SET binding_id=$1 WHERE camera_id=$2', [link,await camera()], '23503');
    await reject('UPDATE camera_bindings SET valid_to=$1 WHERE id=$2', [end,link], '23514');
    await reject('DELETE FROM camera_current_state WHERE camera_id=$1', [a], '23514');
    await sql('UPDATE camera_current_state SET applied_sequence=2,observation_epoch=2 WHERE camera_id=$1',[a]);
    await reject('UPDATE camera_current_state SET applied_sequence=1 WHERE camera_id=$1',[a],'23514');
    await reject('UPDATE camera_current_state SET observation_epoch=1 WHERE camera_id=$1',[a],'23514');
    await reject(`UPDATE camera_current_state SET recording_source_scalars='{"password":"synthetic"}' WHERE camera_id=$1`,[a],'23514');
  });

  await syncObservationSuite(t, db);
  await snapshotWriterSuite(t, db);

  await t.test('migration checksum prevents silent editing of applied history', async () => {
    const original = (await sql("SELECT checksum FROM schema_migrations WHERE id='001_inventory'")).rows[0].checksum;
    await sql("UPDATE schema_migrations SET checksum='synthetic-tamper' WHERE id='001_inventory'");
    await assert.rejects(migrate(db,'up'), /Migration history/);
    await sql("UPDATE schema_migrations SET checksum=$1 WHERE id='001_inventory'", [original]);
  });

  await t.test('002 checksum, unknown migrations and non-prefix histories are rejected', async () => {
    const original = (await sql("SELECT checksum FROM schema_migrations WHERE id='002_sync_observations'")).rows[0].checksum;
    await sql("UPDATE schema_migrations SET checksum='synthetic-tamper' WHERE id='002_sync_observations'");
    await assert.rejects(migrate(db,'up'), /Migration history/);
    await assert.rejects(migrate(db,'down'), /Migration history/);
    await sql("UPDATE schema_migrations SET checksum=$1 WHERE id='002_sync_observations'",[original]);
    await sql("INSERT INTO schema_migrations(id,checksum) VALUES ('999_unknown','synthetic')");
    await assert.rejects(migrate(db,'up'), /Migration history/);
    await sql("DELETE FROM schema_migrations WHERE id='999_unknown'");
    const first = (await sql("SELECT checksum FROM schema_migrations WHERE id='001_inventory'")).rows[0].checksum;
    await sql("DELETE FROM schema_migrations WHERE id='001_inventory'");
    await assert.rejects(migrate(db,'up'), /Migration history/);
    await sql("INSERT INTO schema_migrations(id,checksum) VALUES ('001_inventory',$1)",[first]);
  });

  await t.test('rollback removes only owned objects and reapplication works', async () => {
    await sql('CREATE TABLE synthetic_external_dependency(camera_id uuid REFERENCES cameras(id))');
    await assert.rejects(migrate(db,'down'));
    // Earlier DROP statements must also have been rolled back.
    assert.equal((await sql("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='camera_current_state'")).rows[0].n,1);
    assert.ok(Number((await sql('SELECT count(*)::int AS n FROM cameras')).rows[0].n)>0);
    await sql('DROP TABLE synthetic_external_dependency');
    await migrate(db,'down');
    await migrate(db,'down');
    const remaining = (await sql(`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)).rows;
    assert.deepEqual(remaining, [{ tablename:'schema_migrations' }]);
    assert.equal((await sql("SELECT count(*)::int AS n FROM pg_extension WHERE extname='btree_gist'")).rows[0].n,1);
    await migrate(db,'up');
    assert.equal((await sql('SELECT count(*)::int AS n FROM cameras')).rows[0].n,0);
    await migrate(db,'down');
  });
}
