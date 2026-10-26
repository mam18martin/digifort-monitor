import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { MigrationConnection } from '../src/database/migrations.ts';

/** No network or production fixtures; shared by PGlite and native PostgreSQL 17. */
export async function syncObservationSuite(t: TestContext, db: MigrationConnection): Promise<void> {
  const q = (sql: string, params?: unknown[]) => db.query(sql, params);
  const reject = (sql: string, params: unknown[] = [], code = '23514') => assert.rejects(q(sql, params),
    (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === code);
  const start = '2026-01-01T00:00:00Z';
  const end = '2026-01-01T00:01:00Z';
  const lease = randomUUID();
  const server = (await q("INSERT INTO digifort_servers(config_key,name,endpoint_origin) VALUES ($1,'Test','https://digifort.invalid') RETURNING id", [randomUUID()])).rows[0].id;
  const camera = (await q('INSERT INTO cameras DEFAULT VALUES RETURNING id')).rows[0].id;
  const binding = (await q("INSERT INTO camera_bindings(camera_id,server_id,external_name,valid_from) VALUES ($1,$2,'001F)',$3) RETURNING id", [camera, server, start])).rows[0].id;
  const run = (await q("INSERT INTO sync_runs(request_key,trigger,started_at) VALUES ($1,'manual',$2) RETURNING id", [randomUUID(), start])).rows[0].id;
  await q("INSERT INTO server_sync_control(server_id,issued_sequence,lease_token,lease_until) VALUES ($1,1,$2,'2100-01-01')", [server, lease]);
  const execution = async (sequence: number, outcome = 'success') => {
    if (sequence > 1) await q('UPDATE server_sync_control SET issued_sequence=$2 WHERE server_id=$1', [server, sequence]);
    if (outcome === 'success') await q('UPDATE server_sync_control SET applied_sequence=$2 WHERE server_id=$1', [server, sequence]);
    const global = (await q("INSERT INTO sync_runs(request_key,trigger,started_at) VALUES ($1,'manual',$2) RETURNING id", [randomUUID(), start])).rows[0].id;
    return (await q(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token,started_at,finished_at,outcome,applied_at,
      inventory_completeness,inventory_count,status_count,matched_count,missing_status_count,orphan_status_count)
      VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,'complete',1,1,1,0,0) RETURNING id`,
    [global,server,sequence,lease,start,end,outcome,outcome === 'success' ? end : null])).rows[0].id;
  };
  let applied: unknown;
  await t.test('sync execution keys, outcomes, lease fencing and coverage enforce integrity', async () => {
    await reject("INSERT INTO sync_runs(request_key,trigger,outcome) VALUES ($1,'manual','success')", [randomUUID()]);
    const key = randomUUID();
    await q("INSERT INTO sync_runs(request_key,trigger) VALUES ($1,'manual')", [key]);
    await reject("INSERT INTO sync_runs(request_key,trigger) VALUES ($1,'manual')", [key], '23505');
    await reject('UPDATE server_sync_control SET applied_sequence=2 WHERE server_id=$1', [server]);
    await reject('UPDATE server_sync_control SET lease_token=$2 WHERE server_id=$1', [server,randomUUID()]);
    await reject(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token)
      VALUES ($1,$2,1,1,$3)`, [run,server,randomUUID()]);
    await q("UPDATE server_sync_control SET lease_until='2000-01-01' WHERE server_id=$1",[server]);
    await reject(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token)
      VALUES ($1,$2,1,1,$3)`, [run,server,lease]);
    await q("UPDATE server_sync_control SET lease_until='2100-01-01' WHERE server_id=$1",[server]);
    await reject(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token)
      VALUES ($1,$2,1,2,$3)`, [run,server,lease]);
    applied = await execution(1);
    await reject('UPDATE server_sync_control SET issued_sequence=0 WHERE server_id=$1', [server]);
    await reject('DELETE FROM server_sync_control WHERE server_id=$1', [server]);
    await reject("UPDATE sync_server_runs SET outcome='failed' WHERE id=$1", [applied]);
    await reject(`INSERT INTO sync_server_runs(run_id,server_id,sequence,config_revision,lease_token,started_at,finished_at,outcome,
      applied_at,inventory_completeness,inventory_count,status_count,matched_count,missing_status_count,orphan_status_count)
      VALUES ($1,$2,1,1,$3,$4,$5,'success',$5,'complete',1,1,1,1,0)`, [run,server,lease,start,end]);
  });
  await t.test('endpoint attempts and issues retain typed diagnostics without raw payload fields', async () => {
    const attempt = (await q(`INSERT INTO sync_endpoint_attempts(server_run_id,endpoint,attempt_no,started_at,finished_at,outcome,http_status,row_count,completeness)
      VALUES ($1,'GetCameras',1,$2,$3,'success',200,1,'complete') RETURNING id`,[applied,start,end])).rows[0].id;
    await reject(`INSERT INTO sync_endpoint_attempts(server_run_id,endpoint,attempt_no,started_at,finished_at,outcome,http_status,row_count)
      VALUES ($1,'GetCameras',1,$2,$3,'success',200,1)`, [applied,start,end], '23505');
    await q(`INSERT INTO sync_endpoint_attempts(server_run_id,endpoint,attempt_no,started_at,finished_at,outcome,http_status,error_code)
      VALUES ($1,'GetStatus',1,$2,$3,'http_error',401,'HTTP_ERROR')`, [applied,start,end]);
    await reject(`INSERT INTO sync_endpoint_attempts(server_run_id,endpoint,attempt_no,started_at,finished_at,outcome,http_status,error_code)
      VALUES ($1,'GetStatus',2,$2,$3,'success',200,'HTTP_ERROR')`, [applied,start,end]);
    await q(`INSERT INTO sync_issues(server_run_id,endpoint_attempt_id,camera_id,binding_id,code,stage,severity)
      VALUES ($1,$2,$3,$4,'CAMERA_CODE_CONFLICT','identity','warning')`, [applied,attempt,camera,binding]);
    await reject("INSERT INTO sync_issues(server_run_id,code,stage,severity) VALUES ($1,'private-response','identity','error')", [applied]);
    await reject('UPDATE sync_endpoint_attempts SET row_count=10 WHERE id=$1', [attempt]);
    const columns = (await q("SELECT column_name FROM information_schema.columns WHERE table_name IN ('sync_issues','sync_endpoint_attempts')")).rows;
    assert.ok(!columns.some(r => ['message','payload','body','password','username','url','description','external_name'].includes(String(r.column_name))));
  });
  await t.test('camera observations preserve all nullable Active/Working combinations with provenance and order', async () => {
    let sequence = 0;
    for (const active of [null,false,true]) for (const working of [null,false,true]) {
      sequence++;
      const source = sequence === 1 ? applied : await execution(sequence);
      await q(`INSERT INTO camera_state_changes(camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
        status_active,working,status_coverage,reason,normalization_version)
        VALUES ($1,$2,$3,$4,$5,1,$6,$6,$7,$8,'matched','state_changed',1)`, [camera,binding,server,source,sequence,end,active,working]);
      assert.deepEqual((await q('SELECT active,working FROM camera_state_changes WHERE camera_id=$1 AND state_sequence=$2',[camera,sequence])).rows[0],{active,working});
    }
    await reject("UPDATE camera_state_changes SET last_confirmed_at='2026-01-02' WHERE camera_id=$1 AND state_sequence=1", [camera]);
    await reject('UPDATE camera_state_changes SET working=false WHERE camera_id=$1', [camera]);
    await reject('DELETE FROM camera_state_changes WHERE camera_id=$1', [camera]);
    await reject(`INSERT INTO camera_state_changes(camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
      working,status_coverage,reason,normalization_version) VALUES ($1,$2,$3,$4,10,1,$5,$5,true,'missing','initial',1)`, [camera,binding,server,applied,end]);
    await reject(`INSERT INTO camera_state_changes(camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
      status_coverage,reason,normalization_version) VALUES ($1,$2,$3,$4,10,1,$5,$5,'matched','state_changed',1)`, [camera,binding,server,applied,end]);
    const latest = (await q('SELECT id FROM camera_state_changes WHERE camera_id=$1 ORDER BY state_sequence DESC LIMIT 1',[camera])).rows[0].id;
    await q('UPDATE camera_current_state SET last_state_change_id=$2 WHERE camera_id=$1',[camera,latest]);
    const other = (await q('INSERT INTO cameras DEFAULT VALUES RETURNING id')).rows[0].id;
    await reject('UPDATE camera_current_state SET last_state_change_id=$2 WHERE camera_id=$1',[other,latest],'23503');
    const next = await execution(10);
    await reject(`INSERT INTO camera_state_changes(camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
      status_coverage,reason,normalization_version) VALUES ($1,$2,$3,$4,8,1,$5,$5,'matched','initial',1)`, [camera,binding,server,next,end]);
    const wrongServer = (await q("INSERT INTO digifort_servers(config_key,name,endpoint_origin) VALUES ($1,'Other','https://other.invalid') RETURNING id",[randomUUID()])).rows[0].id;
    await reject(`INSERT INTO camera_state_changes(camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
      status_coverage,reason,normalization_version) VALUES ($1,$2,$3,$4,10,1,$5,$5,'matched','initial',1)`,[camera,binding,wrongServer,next,end]);
  });
  await t.test('server failure health stays separate from camera flags and cannot rewrite history', async () => {
    const source = await execution(11, 'failed');
    const health = (await q(`INSERT INTO server_health_changes(server_id,server_run_id,health_sequence,observed_at,last_confirmed_at,transport_state,query_state)
      VALUES ($1,$2,1,$3,$3,'unreachable','transport_error') RETURNING id`, [server,source,end])).rows[0].id;
    await q(`INSERT INTO server_current_health(server_id,health_change_id,health_sequence,last_attempt_at,consecutive_failures)
      VALUES ($1,$2,1,$3,1)`, [server,health,end]);
    assert.deepEqual((await q('SELECT active,working FROM camera_state_changes WHERE camera_id=$1 ORDER BY state_sequence DESC LIMIT 1',[camera])).rows[0],{active:true,working:true});
    await reject('UPDATE server_health_changes SET query_state=$2 WHERE id=$1', [health,'healthy']);
    await reject('DELETE FROM sync_server_runs WHERE id=$1', [source]);
    await reject(`INSERT INTO server_health_changes(server_id,server_run_id,health_sequence,observed_at,last_confirmed_at,transport_state,query_state)
      VALUES ($1,$2,2,$3,$3,'unreachable','auth_error')`,[server,source,end]);
    await reject('DELETE FROM digifort_servers WHERE id=$1',[server],'23514');
    const cascade = await q(`SELECT count(*)::int AS n FROM pg_constraint WHERE connamespace='public'::regnamespace AND contype='f' AND confdeltype='c'`);
    assert.equal(cascade.rows[0].n,0);
  });
}
