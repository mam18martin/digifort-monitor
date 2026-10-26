import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { MigrationConnection } from '../src/database/migrations.ts';
import { beginServerSync, writeServerSnapshot } from '../src/sync/snapshot-writer.ts';
import { SnapshotWriterError, type EndpointEvidence, type SyncExecution, type SnapshotObservation } from '../src/sync/snapshot-types.ts';
import { parseInventoryJson, parseStatusJson, associateCameras } from '../src/digifort/json-parser.ts';

/** Same writer acceptance suite in embedded and native PostgreSQL 17. */
export async function snapshotWriterSuite(t: TestContext, db: MigrationConnection): Promise<void> {
  const q = (sql: string, params?: unknown[]) => db.query(sql,params);
  const server = String((await q(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
    VALUES ($1,'Writer test','https://digifort.invalid',true) RETURNING id`,[randomUUID()])).rows[0].id);
  const envelope = (rows: unknown[]) => JSON.stringify({Response:{Data:{Cameras:rows}}});
  const policy = {selectInventoryText:(i: {Description:string|null})=>({description:i.Description})};
  const begin = (requestKey = randomUUID()) => beginServerSync(db,{serverId:server,requestKey});
  const evidence = async (e: SyncExecution, inventory: unknown[], statuses: unknown[], completeness: 'complete'|'incomplete'|'unknown' = 'complete'): Promise<SnapshotObservation> => {
    const now = (await q("SELECT date_trunc('milliseconds',clock_timestamp()) AS time")).rows[0].time;
    const at = new Date(now as string).toISOString();
    const started = new Date((await q('SELECT started_at FROM sync_server_runs WHERE id=$1',[e.serverRunId])).rows[0].started_at as string).toISOString();
    return {snapshot:associateCameras(parseInventoryJson(envelope(inventory)),parseStatusJson(envelope(statuses)),{serverId:server}),endpoints:[
      {endpoint:'GetCameras',outcome:'success',httpStatus:200,rowCount:inventory.length,completeness,startedAt:started,finishedAt:at},
      {endpoint:'GetStatus',outcome:'success',httpStatus:200,rowCount:statuses.length,completeness,startedAt:started,finishedAt:at},
    ]};
  };
  const inv = (name = '1390F)', description = name+' Descripción sintética')=>[{Name:name,Description:description,Active:true}];
  const statuses = (active: boolean|null = true, working: boolean|null = true, name = '1390F)', fps = 1)=>[{Name:name,Active:active,Working:working,RecordingFPS:fps}];
  const count = async (table: string) => Number((await q(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);
  const current = async (name = '1390F)') => (await q(`SELECT s.*,c.camera_code FROM camera_current_state s JOIN camera_bindings b ON b.camera_id=s.camera_id
    JOIN cameras c ON c.id=s.camera_id WHERE b.server_id=$1 AND b.external_name=$2 AND b.valid_to IS NULL`,[server,name])).rows[0];
  const write = async (inventory = inv(), status = statuses(), completeness: 'complete'|'incomplete'|'unknown' = 'complete') => {
    const e = await begin();
    const o = await evidence(e,inventory,status,completeness);
    return {e,o,result:await writeServerSnapshot(db,e,o,policy)};
  };
  let firstId: unknown;
  await t.test('writer initial snapshot creates a provisional camera, inventory, state and provenance', async () => {
    const {e} = await write();
    const s = await current(); firstId = s.camera_id;
    assert.equal(s.camera_code,null); assert.equal(s.active,true); assert.equal(s.working,true);
    assert.ok(s.last_state_change_id);
    const v = (await q('SELECT * FROM camera_inventory_versions WHERE camera_id=$1 AND valid_to IS NULL',[s.camera_id])).rows[0];
    assert.equal(v.code_candidate,'1390F'); assert.equal(v.description_original,'1390F) Descripción sintética');
    assert.equal(v.source_server_run_id,e.serverRunId);
    assert.equal(String(s.applied_sequence),e.sequence);
  });
  await t.test('writer same request replays without writes and identical snapshots confirm current state without new history', async () => {
    const before = await count('camera_state_changes');
    const versions = await count('camera_inventory_versions');
    const {e,o} = await write();
    assert.equal(await count('camera_state_changes'),before);
    assert.equal(await count('camera_inventory_versions'),versions);
    const runs = await count('sync_server_runs');
    assert.deepEqual(await writeServerSnapshot(db,e,o,policy),{outcome:'partial',replayed:true});
    assert.equal(await count('sync_server_runs'),runs);
  });
  await t.test('writer actual Active and Working changes create independent transitions', async () => {
    let before = await count('camera_state_changes');
    await write(inv(),statuses(false,true));
    assert.equal(await count('camera_state_changes'),before+1);
    assert.equal((await current()).active,false); assert.equal((await current()).working,true);
    before++;
    await write(inv(),statuses(false,false));
    assert.equal(await count('camera_state_changes'),before+1);
    assert.equal((await current()).active,false); assert.equal((await current()).working,false);
  });
  await t.test('writer preserves NULL flags and Active inventory fallback provenance', async () => {
    await write([{Name:'1390F)',Description:'1390F) Descripción sintética',Active:null}],statuses(null,null));
    assert.equal((await current()).active,null); assert.equal((await current()).working,null);
    assert.equal((await current()).active_observed_at,null); assert.equal((await current()).working_observed_at,null);
    await write(inv(),statuses(null,null));
    assert.equal((await current()).active,true); assert.equal((await current()).active_source,'inventory');
  });
  await t.test('writer metric-only FPS changes never create transitions or inventory versions', async () => {
    await write(inv(),statuses(true,true));
    const history = await count('camera_state_changes'); const versions = await count('camera_inventory_versions');
    await write(inv(),statuses(true,true,'1390F)',30));
    assert.equal(await count('camera_state_changes'),history); assert.equal(await count('camera_inventory_versions'),versions);
    assert.equal(JSON.parse(JSON.stringify((await current()).recording_source_scalars)).RecordingFPS,30);
  });
  await t.test('writer versions approved descriptive changes without touching identity or operational history', async () => {
    const before = await count('camera_inventory_versions'); const history = await count('camera_state_changes');
    // Separate observations must have strictly distinct period boundaries.
    await q("SELECT pg_sleep(0.003)");
    await write(inv('1390F)','Otra descripción'));
    assert.equal(await count('camera_inventory_versions'),before+1); assert.equal(await count('camera_state_changes'),history);
    assert.equal((await current()).camera_id,firstId);
  });
  await t.test('writer records Description candidate without assigning a confirmed identity', async () => {
    await write(inv('camera-without-code','0042F) Independent text'),statuses(true,true,'camera-without-code'));
    const s = await current('camera-without-code'); assert.equal(s.camera_code,null);
    const v = (await q('SELECT code_candidate,code_parse_status FROM camera_inventory_versions WHERE camera_id=$1 AND valid_to IS NULL',[s.camera_id])).rows[0];
    assert.equal(v.code_candidate,'0042F'); assert.equal(v.code_parse_status,'valid');
  });
  await t.test('writer preserves confirmed codes and records duplicate candidates across servers', async () => {
    await q("UPDATE cameras SET camera_number='9999',camera_type_code='D',identity_review='confirmed' WHERE id=$1",[firstId]);
    await write(inv('1390F)','Conflicting Name'),statuses());
    assert.equal((await current()).camera_code,'9999D');
    const issue = await q("SELECT count(*)::int AS n FROM sync_issues WHERE camera_id=$1 AND code='CAMERA_CODE_CONFLICT'",[firstId]);
    assert.ok(Number(issue.rows[0].n)>0);
    const another = String((await q(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
      VALUES ($1,'Other','https://other.invalid',true) RETURNING id`,[randomUUID()])).rows[0].id);
    const e = await beginServerSync(db,{serverId:another,requestKey:randomUUID()});
    const o = await evidence(e,inv('9999D)'),statuses(true,true,'9999D)'));
    o.snapshot!.serverId=another; for(const c of o.snapshot!.cameras)c.serverId=another;
    await writeServerSnapshot(db,e,o,policy);
    const other = (await q('SELECT camera_id FROM camera_bindings WHERE server_id=$1',[another])).rows[0];
    assert.notEqual(other.camera_id,firstId);
    assert.equal((await q('SELECT camera_code FROM cameras WHERE id=$1',[other.camera_id])).rows[0].camera_code,null);
    assert.ok(Number((await q("SELECT count(*)::int AS n FROM sync_issues WHERE camera_id=$1 AND code='CAMERA_CODE_CONFLICT'",[other.camera_id])).rows[0].n)>0);
  });
  await t.test('writer new Name and replacement code create distinct provisional UUIDs without closing old bindings', async () => {
    await write(inv('1390F) renamed'),statuses(true,true,'1390F) renamed'));
    await write(inv('2000P)'),statuses(true,true,'2000P)'));
    assert.notEqual((await current('1390F) renamed')).camera_id,firstId);
    assert.notEqual((await current('2000P)')).camera_id,firstId);
    assert.equal((await current()).camera_id,firstId); assert.equal((await current()).camera_code,'9999D');
  });
  await t.test('writer incomplete/unknown and empty snapshots preserve unobserved cameras', async () => {
    const before = await current();
    await write([],[],'incomplete'); await write([],[],'unknown');
    const after = await current();
    assert.equal(after.inventory_presence,'present'); assert.equal(after.active,before.active); assert.equal(after.working,before.working);
    assert.equal(iso(after.last_snapshot_success_at),iso(before.last_snapshot_success_at));
  });
  await t.test('writer missing status changes coverage to missing and flags to unknown, never false', async () => {
    await write(inv(),[],'incomplete'); const s = await current();
    assert.equal(s.status_coverage,'missing'); assert.equal(s.working,null); assert.equal(s.status_active,null); assert.equal(s.inventory_active,true);
    const event = (await q('SELECT reason FROM camera_state_changes WHERE id=$1',[s.last_state_change_id])).rows[0];
    assert.ok(['coverage_changed','resumed'].includes(String(event.reason)));
  });
  await t.test('writer endpoint failure only records diagnostics and server health, not camera state', async () => {
    const e = await begin();const o = await evidence(e,inv(),statuses());
    o.endpoints[1]={endpoint:'GetStatus',outcome:'http_error',httpStatus:401,errorCode:'HTTP_ERROR',startedAt:o.endpoints[1].startedAt,finishedAt:o.endpoints[1].finishedAt};
    const before=await current();const history=await count('camera_state_changes');
    assert.equal((await writeServerSnapshot(db,e,o,policy)).outcome,'failed');
    assert.equal(await count('camera_state_changes'),history);assert.deepEqual(await current(),before);
    const health=(await q(`SELECT e.transport_state,e.query_state,h.consecutive_failures FROM server_current_health h
      JOIN server_health_changes e ON e.id=h.health_change_id WHERE h.server_id=$1`,[server])).rows[0];
    assert.equal(health.transport_state,'responding');assert.equal(health.query_state,'partial');assert.equal(health.consecutive_failures,1);
    await write();assert.equal((await current()).working,true);
    const event=(await q('SELECT reason FROM camera_state_changes WHERE id=$1',[(await current()).last_state_change_id])).rows[0];
    assert.equal(event.reason,'resumed');
  });
  await t.test('writer typed endpoint failures retain camera states and distinguish authentication, parsing and connectivity', async () => {
    const before=await current();
    const cases: Array<{failure:Omit<Extract<EndpointEvidence,{outcome:'http_error'|'transport_error'|'invalid_response'|'configuration_error'}>,'endpoint'|'startedAt'|'finishedAt'>;transport:string;query:string}>=[
      {failure:{outcome:'http_error',httpStatus:401,errorCode:'HTTP_ERROR'},transport:'responding',query:'auth_error'},
      {failure:{outcome:'http_error',httpStatus:500,errorCode:'HTTP_ERROR'},transport:'responding',query:'http_error'},
      {failure:{outcome:'transport_error',errorCode:'TIMEOUT'},transport:'unknown',query:'transport_error'},
      {failure:{outcome:'invalid_response',errorCode:'INVALID_JSON'},transport:'responding',query:'invalid_response'},
      {failure:{outcome:'configuration_error',errorCode:'CONFIGURATION'},transport:'unknown',query:'configuration_error'},
    ];
    for(const item of cases){
      const e=await begin();const o=await evidence(e,inv(),statuses());
      o.endpoints=o.endpoints.map(x=>({endpoint:x.endpoint,startedAt:x.startedAt,finishedAt:x.finishedAt,...item.failure})) as SnapshotObservation['endpoints'];
      assert.equal((await writeServerSnapshot(db,e,o,policy)).outcome,'failed');
      assert.deepEqual(await current(),before);
      const health=(await q(`SELECT e.transport_state,e.query_state FROM server_current_health h
        JOIN server_health_changes e ON e.id=h.health_change_id WHERE h.server_id=$1`,[server])).rows[0];
      assert.equal(health.transport_state,item.transport);assert.equal(health.query_state,item.query);
    }
    await write();
  });
  await t.test('writer injected persistence failure rolls back every partial mutation and permits retry', async () => {
    const e=await begin();const o=await evidence(e,inv('rollback-new'),statuses(true,false,'rollback-new'));
    const before=await count('camera_bindings');const events=await count('camera_state_changes');
    const broken: MigrationConnection={exec:s=>db.exec(s),query:async (s,p)=>{
      if(s.startsWith('UPDATE camera_current_state SET binding_id'))await db.exec('SELECT * FROM deliberately_missing_writer_table');
      return db.query(s,p);
    }};
    await assert.rejects(writeServerSnapshot(broken,e,o,policy),isError('PERSISTENCE_FAILED'));
    assert.equal(await count('camera_bindings'),before);assert.equal(await count('camera_state_changes'),events);
    assert.equal((await q('SELECT outcome FROM sync_server_runs WHERE id=$1',[e.serverRunId])).rows[0].outcome,'running');
    await writeServerSnapshot(db,e,o,policy);assert.equal((await current('rollback-new')).working,false);
  });
  await t.test('writer stale, superseded and expired leases cannot apply data', async () => {
    const old=await begin();const oldObservation=await evidence(old,inv('stale'),statuses(true,true,'stale'));
    await q("UPDATE server_sync_control SET lease_until=clock_timestamp()-interval '1 second' WHERE server_id=$1",[server]);
    await assert.rejects(writeServerSnapshot(db,old,oldObservation,policy),isError('STALE_EXECUTION'));
    const fresh=await begin();const o=await evidence(fresh,inv('fresh'),statuses(true,true,'fresh'));
    await assert.rejects(writeServerSnapshot(db,old,oldObservation,policy),isError('STALE_EXECUTION'));
    await writeServerSnapshot(db,fresh,o,policy);
    assert.equal((await q("SELECT count(*)::int AS n FROM camera_bindings WHERE server_id=$1 AND external_name='stale'",[server])).rows[0].n,0);
  });
  await t.test('writer rejects backwards observation timestamps even with a new valid sequence', async () => {
    const e=await begin();const o=await evidence(e,inv('backdated'),statuses(true,true,'backdated'));
    const old='2000-01-01T00:00:00.000Z';
    for(const endpoint of o.endpoints){endpoint.startedAt=old;endpoint.finishedAt=old;}
    await assert.rejects(writeServerSnapshot(db,e,o,policy),isError('INVALID_OBSERVATION'));
    await writeServerSnapshot(db,e,await evidence(e,inv('backdated'),statuses(true,true,'backdated')),policy);
  });
  await t.test('writer expiry during persistence rolls back rows written earlier in the transaction', async () => {
    const e=await begin();const o=await evidence(e,inv('expired-during-write'),statuses(true,true,'expired-during-write'));
    const before=await count('camera_bindings');
    let injected=false;
    const slow:MigrationConnection={exec:s=>db.exec(s),query:async(s,p)=>{
      const result=await db.query(s,p);
      if(s.startsWith('UPDATE sync_runs SET outcome')){
        injected=true;
        await q("UPDATE server_sync_control SET lease_until=clock_timestamp()-interval '1 second' WHERE server_id=$1",[server]);
      }
      return result;
    }};
    await assert.rejects(writeServerSnapshot(slow,e,o,policy),isError('STALE_EXECUTION'));
    assert.equal(injected,true);assert.equal(await count('camera_bindings'),before);
    await writeServerSnapshot(db,e,o,policy);
  });
  await t.test('writer refuses inconsistent coverage without partial writes and accepts corrected retry', async () => {
    const e=await begin();const o=await evidence(e,inv(),statuses());
    o.snapshot!.coverage.matched=100;
    await assert.rejects(writeServerSnapshot(db,e,o,policy),isError('INVALID_OBSERVATION'));
    o.snapshot!.coverage.matched=1;await writeServerSnapshot(db,e,o,policy);
  });
  await t.test('writer rejects nonconsecutive attempts and mismatched final results atomically', async () => {
    const e=await begin();const o=await evidence(e,inv(),statuses());
    o.attempts=[{...o.endpoints[0],attemptNo:2},{...o.endpoints[1],attemptNo:1}];
    await assert.rejects(writeServerSnapshot(db,e,o,policy),isError('INVALID_OBSERVATION'));
    o.attempts=[{...o.endpoints[0],attemptNo:1},{...o.endpoints[1],attemptNo:1,httpStatus:201}];
    await assert.rejects(writeServerSnapshot(db,e,o,policy),isError('INVALID_OBSERVATION'));
    const stored=(await q('SELECT count(*)::int AS n FROM sync_endpoint_attempts WHERE server_run_id=$1',[e.serverRunId])).rows[0];
    assert.equal(stored.n,0);
    o.attempts=[{...o.endpoints[0],attemptNo:1},{...o.endpoints[1],attemptNo:1}];
    await writeServerSnapshot(db,e,o,policy);
  });
  await t.test('writer rejects sensitive Description atomically; diagnostics and errors retain no secret', async () => {
    const e=await begin();const o=await evidence(e,inv('safe-name','https://private.invalid/?AuthPass=synthetic-secret'),statuses(true,true,'safe-name'));
    await assert.rejects(writeServerSnapshot(db,e,o),isError('INVALID_OBSERVATION'));
    assert.equal((await q("SELECT count(*)::int n FROM camera_bindings WHERE server_id=$1 AND external_name='safe-name'",[server])).rows[0].n,0);
    const diagnostics=JSON.stringify((await q('SELECT * FROM sync_issues WHERE server_run_id=$1',[e.serverRunId])).rows);
    assert.ok(!diagnostics.includes('synthetic-secret'));assert.ok(!diagnostics.includes('private.invalid'));
  });
}
function iso(v: unknown) {return new Date(v as string).toISOString();}
export function isError(code: string) { return (e: unknown) => e instanceof SnapshotWriterError && e.code===code && !e.message.includes('synthetic-secret') && !e.cause; }
