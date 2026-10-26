import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { TestContext } from 'node:test';
import type { MigrationConnection } from '../src/database/migrations.ts';
import { beginServerSync,writeServerSnapshot } from '../src/sync/snapshot-writer.ts';
import { associateCameras,parseInventoryJson,parseStatusJson } from '../src/digifort/json-parser.ts';
import { reviewIdentityProposal,IdentityReviewError } from '../src/identity/index.ts';

/** Parent native harness supplies only the isolated, empty test database connection. */
export async function identityReviewConcurrencyTests(t:TestContext,client:pg.Client,
  competitor:()=>Promise<{connection:pg.Client;pid:number}>,waitForBlock:(pid:number)=>Promise<void>){
  const adapt=(c:pg.Client):MigrationConnection=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p)});
  const proposal=async(name:string)=>{
    let cameraId:string|undefined;
    for(let i=0;i<2;i++){
      const serverId=(await client.query(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
        VALUES ($1,'Native review','https://digifort.invalid',true) RETURNING id`,[randomUUID()])).rows[0].id;
      const e=await beginServerSync(adapt(client),{serverId,requestKey:randomUUID()});const at=new Date().toISOString();
      const json=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
      const snapshot=associateCameras(parseInventoryJson(json([{Name:name,Description:name,Active:true}])),parseStatusJson(json([{Name:name,Active:true,Working:true}])),{serverId});
      await writeServerSnapshot(adapt(client),e,{snapshot,endpoints:[
        {endpoint:'GetCameras',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at},
        {endpoint:'GetStatus',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at},
      ]});
      cameraId=(await client.query('SELECT camera_id FROM camera_bindings WHERE server_id=$1',[serverId])).rows[0].camera_id;
    }
    return String((await client.query("SELECT id FROM identity_proposals WHERE camera_id=$1 AND kind='duplicate_code'",[cameraId])).rows[0].id);
  };
  for(const identical of [false,true]){
    await t.test(identical?'identity concurrent decision retries serialize to one audit event':'identity concurrent incompatible reviews wait and reject the stale revision',async()=>{
      const proposalId=await proposal(identical?'9101F)':'9100F)');const other=await competitor();
      let locked!:()=>void,release!:()=>void;
      const ready=new Promise<void>(r=>{locked=r;});const gate=new Promise<void>(r=>{release=r;});
      const db:MigrationConnection={exec:s=>client.query(s),query:async(s,p)=>{
        const result=await client.query(s,p);
        if(s.startsWith('INSERT INTO identity_review_events')){locked();await gate;}
        return result;
      }};
      const input={proposalId,requestKey:randomUUID(),expectedRevision:'1',operatorId:randomUUID(),action:'note' as const,reasonCode:'evidence_reviewed' as const};
      const first=reviewIdentityProposal(db,input);void first.catch(()=>{});
      let second:ReturnType<typeof reviewIdentityProposal>|undefined;
      try{
        await ready;
        second=reviewIdentityProposal(adapt(other.connection),identical?input:{...input,requestKey:randomUUID(),operatorId:randomUUID(),action:'reject'});
        void second.catch(()=>{});
        await waitForBlock(other.pid);release();const receipt=await first;
        if(identical){const replay=await second;assert.equal(replay.replayed,true);assert.equal(replay.decisionId,receipt.decisionId);}
        else await assert.rejects(second,e=>e instanceof IdentityReviewError && e.code==='REVISION_CONFLICT');
        assert.equal((await client.query('SELECT count(*)::int AS n FROM identity_review_events WHERE proposal_id=$1',[proposalId])).rows[0].n,1);
        const state=(await client.query('SELECT state,revision FROM identity_proposals WHERE id=$1',[proposalId])).rows[0];
        assert.equal(state.state,'pending');assert.equal(String(state.revision),'2');
      }finally{release();await first.catch(()=>{});await second?.catch(()=>{});await other.connection.end();}
    });
  }
}
