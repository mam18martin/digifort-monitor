import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { TestContext } from 'node:test';
import type { MigrationConnection } from '../src/database/migrations.ts';
import { beginServerSync, writeServerSnapshot } from '../src/sync/snapshot-writer.ts';
import { SnapshotWriterError, type SnapshotObservation } from '../src/sync/snapshot-types.ts';
import { associateCameras, parseInventoryJson, parseStatusJson } from '../src/digifort/json-parser.ts';

/** Requires the parent's fresh, isolated native test connection; never standalone. */
export async function writerConcurrencyTests(t: TestContext, client: pg.Client,
  competitor: () => Promise<{connection: pg.Client; pid: number}>, waitForBlock: (pid:number)=>Promise<void>) {
  const adapt = (c: pg.Client): MigrationConnection => ({exec:s=>c.query(s),query:(s,p)=>c.query(s,p)});
  const server = async () => String((await client.query(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
    VALUES ($1,'Native writer','https://digifort.invalid',true) RETURNING id`,[randomUUID()])).rows[0].id);
  const observation = (serverId: string): SnapshotObservation => {
    const json=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
    const at=new Date().toISOString();
    return {snapshot:associateCameras(parseInventoryJson(json([{Name:'native-writer',Active:true}])),
      parseStatusJson(json([{Name:'native-writer',Active:true,Working:false}])),{serverId}),endpoints:[
      {endpoint:'GetCameras',outcome:'success',httpStatus:200,rowCount:1,completeness:'complete',startedAt:at,finishedAt:at},
      {endpoint:'GetStatus',outcome:'success',httpStatus:200,rowCount:1,completeness:'complete',startedAt:at,finishedAt:at},
    ]};
  };
  await t.test('writer concurrent replay waits for the winner and never duplicates cameras or events',async()=>{
    const other=await competitor();const serverId=await server();
    const e=await beginServerSync(adapt(client),{serverId,requestKey:randomUUID()});
    const o=observation(serverId);
    let locked!:()=>void;let release!:()=>void;
    const ready=new Promise<void>(r=>{locked=r;});const gate=new Promise<void>(r=>{release=r;});
    const db:MigrationConnection={exec:s=>client.query(s),query:async(s,p)=>{
      const result=await client.query(s,p);
      if(s==='SELECT id FROM digifort_servers WHERE id=$1 FOR UPDATE'){locked();await gate;}
      return result;
    }};
    const first=writeServerSnapshot(db,e,o);void first.catch(()=>{});
    let second:ReturnType<typeof writeServerSnapshot>|undefined;
    try{
      await ready;second=writeServerSnapshot(adapt(other.connection),e,o);void second.catch(()=>{});
      await waitForBlock(other.pid);release();
      assert.equal((await first).replayed,false);assert.equal((await second).replayed,true);
      const counts=(await client.query(`SELECT (SELECT count(*)::int FROM camera_bindings WHERE server_id=$1) AS bindings,
        (SELECT count(*)::int FROM camera_state_changes WHERE server_id=$1) AS events`,[serverId])).rows[0];
      assert.deepEqual(counts,{bindings:1,events:1});
    }finally{release();await first.catch(()=>{});await second?.catch(()=>{});await other.connection.end();}
  });
  await t.test('writer competing requests wait for reservation and the loser cannot steal a live lease',async()=>{
    const other=await competitor();const serverId=await server();
    let locked!:()=>void;let release!:()=>void;
    const ready=new Promise<void>(r=>{locked=r;});const gate=new Promise<void>(r=>{release=r;});
    const db:MigrationConnection={exec:s=>client.query(s),query:async(s,p)=>{
      const result=await client.query(s,p);
      if(s.startsWith('UPDATE server_sync_control SET issued_sequence')){locked();await gate;}
      return result;
    }};
    const first=beginServerSync(db,{serverId,requestKey:randomUUID()});void first.catch(()=>{});
    let second:ReturnType<typeof beginServerSync>|undefined;
    try{
      await ready;second=beginServerSync(adapt(other.connection),{serverId,requestKey:randomUUID()});void second.catch(()=>{});
      await waitForBlock(other.pid);release();
      const e=await first;
      await assert.rejects(second,x=>x instanceof SnapshotWriterError && x.code==='LEASE_UNAVAILABLE');
      await writeServerSnapshot(adapt(client),e,observation(serverId));
    }finally{release();await first.catch(()=>{});await second?.catch(()=>{});await other.connection.end();}
  });
}
