import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { migrate, type MigrationConnection } from '../src/database/migrations.ts';
import { beginServerSync } from '../src/sync/snapshot-writer.ts';
import { synchronizeServerManually, ManualSyncError } from '../src/sync/manual-coordinator.ts';
import type { ManualSyncOptions } from '../src/sync/manual-coordinator.ts';

let db:PGlite;
before(async()=>{db=new PGlite({extensions:{btree_gist}});await db.exec('CREATE EXTENSION btree_gist');await migrate(db,'up');});
after(async()=>{await db?.close();});
const body=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
const normal:typeof globalThis.fetch=async url=>new Response(body(String(url).includes('GetCameras')?
  [{Name:'1390F)',Description:'1390F)  Independent description )  ',Active:true}]:[{Name:'1390F)',Active:true,Working:true}]));
async function options(fetch:typeof globalThis.fetch=normal):Promise<ManualSyncOptions>{
  const key=`synthetic-${randomUUID()}`;
  const serverId=(await db.query<{id:string}>(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
    VALUES ($1,'Synthetic','https://digifort.invalid',true) RETURNING id`,[key])).rows[0].id;
  return {serverId,requestKey:randomUUID(),server:{id:key,baseUrl:'https://digifort.invalid',username:'synthetic-user',password:'synthetic-secret'},
    fetch,timeoutMs:100,retryDelayMs:0,writerOptions:{selectInventoryText:i=>({description:i.Description})}};
}
const run=(o:ManualSyncOptions,connection:MigrationConnection=db)=>synchronizeServerManually(connection,o);
const current=async(serverId:string)=>(await db.query(`SELECT s.*,c.camera_code,v.description_original,v.code_candidate FROM camera_current_state s
  JOIN cameras c ON c.id=s.camera_id JOIN camera_bindings b ON b.id=s.binding_id
  JOIN camera_inventory_versions v ON v.binding_id=b.id AND v.valid_to IS NULL WHERE b.server_id=$1`,[serverId])).rows;
const error=(code:string)=>(e:unknown)=>e instanceof ManualSyncError && e.code===code && !e.cause && !e.message.includes('synthetic-secret');

test('manual coordinator integrates fixtures, internal UUID/external config key and unchanged descriptions',async()=>{
  const o=await options();const result=await run(o);assert.equal(result.outcome,'partial');assert.equal(result.attempts.length,2);
  assert.deepEqual(result.coverage,{matched:1,missingStatus:0,orphanStatus:0});
  assert.equal(result.replayed,false);assert.ok(result.attempts.every(a=>a.completeness==='unknown'&&a.responseReceived&&a.responseValid));
  const [state]=await current(o.serverId);assert.equal(state.camera_code,null);assert.equal(state.code_candidate,'1390F');
  assert.equal(state.description_original,'1390F)  Independent description )  ');assert.equal(state.working,true);
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.ok(!JSON.stringify(result).includes('Independent description'));
});
test('manual terminal replay performs no new network calls or data writes',async()=>{
  let calls=0;const o=await options(async(url,init)=>{calls++;return normal(url,init);});
  const first=await run(o);const second=await run(o);
  assert.deepEqual(second.coverage,first.coverage);assert.equal(calls,2);assert.equal(second.replayed,true);assert.equal(second.serverRunId,first.serverRunId);
  assert.ok(second.attempts.every(a=>a.durationSource==='wall_clock'));
});
for(const endpoint of ['GetCameras','GetStatus'] as const){
  test(`manual independent ${endpoint} failure preserves all prior camera state`,async()=>{
    const o=await options();await run(o);const before=await current(o.serverId);
    const failed={...o,requestKey:randomUUID(),fetch:async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>
      String(url).includes(endpoint)?new Response('synthetic-secret',{status:401}):normal(url,init)};
    const result=await run(failed);assert.equal(result.outcome,'failed');assert.deepEqual(await current(o.serverId),before);
    assert.equal(result.attempts.find(a=>a.endpoint===endpoint)!.errorCode,'HTTP_ERROR');
    assert.equal(result.attempts.find(a=>a.endpoint===endpoint)!.httpStatus,401);
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  });
}
test('manual timeout is bounded and does not fabricate false camera flags',async()=>{
  const o=await options();await run(o);const before=await current(o.serverId);
  const failed=await run({...o,requestKey:randomUUID(),timeoutMs:10,fetch:async()=>new Promise<Response>(()=>{})});
  assert.equal(failed.outcome,'failed');assert.ok(failed.attempts.every(a=>a.errorCode==='TIMEOUT'&&a.responseReceived===false));
  assert.deepEqual(await current(o.serverId),before);
});
test('manual retries are persisted as separate attempts; only the failed endpoint is repeated',async()=>{
  let cameras=0,status=0;
  const o=await options(async(url,init)=>{
    if(String(url).includes('GetCameras')){cameras++;if(cameras===1)return new Response('private',{status:503});}else status++;
    return normal(url,init);
  });o.maxAttempts=3;
  const result=await run(o);assert.equal(cameras,2);assert.equal(status,1);assert.equal(result.attempts.length,3);
  const rows=(await db.query('SELECT endpoint,attempt_no,outcome FROM sync_endpoint_attempts WHERE server_run_id=$1 ORDER BY endpoint,attempt_no',[result.serverRunId])).rows;
  assert.deepEqual(rows.map(r=>r.outcome),['http_error','success','success']);
  const replay=await run(o);assert.equal(replay.attempts.length,3);assert.equal(cameras,2);
});
test('manual health retains earlier HTTP response evidence when final retries fail in transport',async()=>{
  const calls=new Map<string,number>();
  const o=await options(async url=>{
    const endpoint=String(url).includes('GetCameras')?'GetCameras':'GetStatus';
    const n=(calls.get(endpoint)??0)+1;calls.set(endpoint,n);
    if(n===1)return new Response('private',{status:503});
    throw new Error('synthetic-secret');
  });o.maxAttempts=2;
  const result=await run(o);assert.equal(result.outcome,'failed');assert.equal(result.attempts.length,4);
  const health=(await db.query(`SELECT c.transport_state,c.query_state FROM server_current_health h
    JOIN server_health_changes c ON c.id=h.health_change_id WHERE h.server_id=$1`,[o.serverId])).rows[0];
  assert.equal(health.transport_state,'responding');assert.equal(health.query_state,'transport_error');
});
test('manual empty bodies and duplicate names are rejected independently without creating cameras',async()=>{
  for(const payload of ['',body([{Name:'duplicate'},{Name:'duplicate'}])]){
    const o=await options(async()=>new Response(payload));const result=await run(o);
    assert.equal(result.outcome,'failed');assert.equal((await current(o.serverId)).length,0);
    assert.ok(result.attempts.every(a=>a.responseReceived&&!a.responseValid));
    assert.ok(result.attempts.every(a=>['INVALID_JSON','DUPLICATE_NAME'].includes(a.errorCode!)));
  }
});
test('manual valid empty or partial replies never certify completeness or infer camera disappearance',async()=>{
  const o=await options();await run(o);
  const before=await current(o.serverId);
  const empty=await run({...o,requestKey:randomUUID(),fetch:async()=>new Response(body([]))});
  assert.equal(empty.outcome,'partial');assert.ok(empty.attempts.every(a=>a.rowCount===0&&a.responseValid&&a.completeness==='unknown'));
  assert.deepEqual(await current(o.serverId),before);
  const partial=await run({...o,requestKey:randomUUID(),fetch:async(url,init)=>String(url).includes('GetStatus')?new Response(body([])):normal(url,init)});
  assert.deepEqual(partial.coverage,{matched:0,missingStatus:1,orphanStatus:0});
  assert.equal(partial.outcome,'partial');const [state]=await current(o.serverId);assert.equal(state.status_coverage,'missing');assert.equal(state.working,null);
});
test('manual configuration origin/key mismatch is recorded without issuing network requests',async()=>{
  for(const wrong of ['key','origin','credentials']){
    const o=await options(async()=>{assert.fail('No network request permitted');});
    if(wrong==='key')o.server.id='wrong-key';
    if(wrong==='origin')o.server.baseUrl='https://other.invalid';
    if(wrong==='credentials')o.server.password='';
    const result=await run(o);assert.equal(result.outcome,'failed');assert.ok(result.attempts.every(a=>a.errorCode==='CONFIGURATION'));
  }
});
test('manual expired reservation is abandoned on a new request and no longer blocks synchronization',async()=>{
  const o=await options();const old=await beginServerSync(db,{serverId:o.serverId,requestKey:randomUUID()});
  await db.query("UPDATE server_sync_control SET lease_until=clock_timestamp()-interval '1 second' WHERE server_id=$1",[o.serverId]);
  const result=await run(o);assert.equal(result.outcome,'partial');
  assert.equal((await db.query('SELECT outcome FROM sync_server_runs WHERE id=$1',[old.serverRunId])).rows[0].outcome,'abandoned');
  assert.equal((await db.query('SELECT outcome FROM sync_runs WHERE id=$1',[old.runId])).rows[0].outcome,'abandoned');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM sync_issues WHERE server_run_id=$1 AND code='WORKER_ABANDONED'",[old.serverRunId])).rows[0].n,1);
  await run({...o,requestKey:randomUUID()});
});
test('manual still-live reservation rejects a competing request before collection',async()=>{
  const o=await options(async()=>{assert.fail('No transport expected');});await beginServerSync(db,{serverId:o.serverId,requestKey:randomUUID()});
  await assert.rejects(run(o),error('LEASE_UNAVAILABLE'));
});
test('manual concurrent logical requests fence a delayed old collector after lease recovery',async()=>{
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
  const o=await options(async(url,init)=>{entered();await gate;return normal(url,init);});
  const first=run(o);void first.catch(()=>{});
  try{
    await ready;
    await db.query("UPDATE server_sync_control SET lease_until=clock_timestamp()-interval '1 second' WHERE server_id=$1",[o.serverId]);
    const newer=await run({...o,requestKey:randomUUID(),fetch:normal});const before=await current(o.serverId);
    release();await assert.rejects(first,error('STALE_EXECUTION'));
    assert.deepEqual(await current(o.serverId),before);assert.equal(newer.outcome,'partial');
  }finally{release();await first.catch(()=>{});}
});
test('manual duplicate in-flight request branch rejects before reservation or network activity',async()=>{
  const o=await options(async()=>{assert.fail('No transport expected');});
  const busy:MigrationConnection={exec:()=>assert.fail('No transaction expected'),query:async()=>({rows:[{locked:false}]})} as MigrationConnection;
  await assert.rejects(run(o,busy),error('IN_PROGRESS'));
});
test('manual transport exception and database exception never expose credentials',async()=>{
  const o=await options(async()=>{throw new Error('https://user:synthetic-secret@private.invalid/raw');});
  const result=await run(o);assert.ok(result.attempts.every(a=>a.errorCode==='NETWORK_ERROR'));assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  const broken:MigrationConnection={exec:async()=>{throw new Error('synthetic-secret');},query:async()=>{throw new Error('synthetic-secret');}};
  await assert.rejects(run(o,broken),error('PERSISTENCE_FAILED'));
});
test('manual body timeouts preserve received/valid distinction and server response evidence',async()=>{
  const o=await options(async()=>new Response(new ReadableStream<Uint8Array>({})));o.timeoutMs=10;
  const result=await run(o);assert.equal(result.outcome,'failed');assert.ok(result.attempts.every(a=>a.responseReceived&&!a.responseValid&&a.httpStatus===200));
  const health=(await db.query(`SELECT c.transport_state FROM server_current_health h JOIN server_health_changes c ON c.id=h.health_change_id WHERE h.server_id=$1`,[o.serverId])).rows[0];
  assert.equal(health.transport_state,'responding');
  const replay=await run(o);assert.ok(replay.attempts.every(a=>a.responseReceived===null));
});
