import {migrationIds} from '../src/database/migrations.ts';
import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { migrate,type MigrationConnection } from '../src/database/migrations.ts';
import { beginServerSync,writeServerSnapshot } from '../src/sync/snapshot-writer.ts';
import { SnapshotWriterError,type SnapshotObservation } from '../src/sync/snapshot-types.ts';
import { associateCameras,parseInventoryJson,parseStatusJson } from '../src/digifort/json-parser.ts';
import { detectIdentityProposals,registerIdentityHypothesis,reviewIdentityProposal,applyIdentityProposal,readIdentityProposal,IdentityReviewError } from '../src/identity/index.ts';
let db:PGlite;
before(async()=>{db=new PGlite({extensions:{btree_gist}});await db.exec('CREATE EXTENSION btree_gist');await migrate(db,'up');});
after(async()=>{await db?.close();});
const q=(sql:string,p?:unknown[])=>db.query(sql,p);
const error=(code:string)=>(e:unknown)=>e instanceof IdentityReviewError && e.code===code && e.cause===undefined;
async function server(){return String((await q(`INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled)
  VALUES ($1,'Synthetic','https://digifort.invalid',true) RETURNING id`,[randomUUID()])).rows[0].id);}
async function prepare(serverId:string,name:string){
  const e=await beginServerSync(db,{serverId,requestKey:randomUUID()});
  const at=new Date().toISOString();const json=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
  const snapshot=associateCameras(parseInventoryJson(json([{Name:name,Description:name+' Independent description',Active:true}])),
    parseStatusJson(json([{Name:name,Active:true,Working:true}])),{serverId});
  const o:SnapshotObservation={snapshot,endpoints:[
    {endpoint:'GetCameras',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at},
    {endpoint:'GetStatus',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at},
  ]};
  return {e,o};
}
async function write(serverId:string,name:string){const {e,o}=await prepare(serverId,name);await writeServerSnapshot(db,e,o);return e;}
async function observation(serverId:string,name:string){return (await q(`SELECT b.id AS binding_id,b.camera_id,v.id AS inventory_id,c.camera_code
  FROM camera_bindings b JOIN cameras c ON c.id=b.camera_id JOIN camera_inventory_versions v ON v.binding_id=b.id AND v.valid_to IS NULL
  WHERE b.server_id=$1 AND b.external_name=$2 AND b.valid_to IS NULL`,[serverId,name])).rows[0];}

test('identity detection records duplicate candidates with execution references and idempotent evidence',async()=>{
  const a=await server(),b=await server();await write(a,'8100F)');const run=await write(b,'8100F)');
  const proposals=await detectIdentityProposals(db,run.serverRunId);const p=proposals.find(p=>p.kind==='duplicate_code')!;
  assert.ok(p);assert.equal(p.created,false);assert.equal(p.state,'pending');
  await detectIdentityProposals(db,run.serverRunId);
  assert.equal((await q('SELECT count(*)::int AS n FROM identity_proposal_evidence WHERE proposal_id=$1',[p.proposalId])).rows[0].n,1);
  const newer=await write(b,'8100F)');const repeated=await detectIdentityProposals(db,newer.serverRunId);
  assert.equal(repeated.find(x=>x.kind==='duplicate_code')!.proposalId,p.proposalId);
  assert.equal((await q('SELECT count(*)::int AS n FROM identity_proposal_evidence WHERE proposal_id=$1',[p.proposalId])).rows[0].n,2);
  const first=await observation(a,'8100F)'),second=await observation(b,'8100F)');
  assert.notEqual(first.camera_id,second.camera_id);assert.equal(first.camera_code,null);assert.equal(second.camera_code,null);
  const stored=(await q('SELECT observed_code FROM identity_proposals WHERE id=$1',[p.proposalId])).rows[0];assert.equal(stored.observed_code,'8100F');
});
test('identity detection preserves confirmed code and records Description discrepancy without moving history',async()=>{
  const id=await server();await write(id,'8200F)');const original=await observation(id,'8200F)');
  await q("UPDATE cameras SET camera_number='8201',camera_type_code='D',identity_review='confirmed' WHERE id=$1",[original.camera_id]);
  const run=await write(id,'8200F)');const proposals=await detectIdentityProposals(db,run.serverRunId);
  const p=proposals.find(x=>x.kind==='confirmed_code_mismatch')!;assert.ok(p);
  const stored=(await q('SELECT observed_code,confirmed_code,camera_id FROM identity_proposals WHERE id=$1',[p.proposalId])).rows[0];
  assert.equal(stored.observed_code,'8200F');assert.equal(stored.confirmed_code,'8201D');assert.equal(stored.camera_id,original.camera_id);
  assert.equal((await observation(id,'8200F)')).camera_code,'8201D');
  assert.equal((await q('SELECT count(DISTINCT camera_id)::int AS n FROM camera_state_changes WHERE camera_id=$1',[original.camera_id])).rows[0].n,1);
});
test('identity Name change can be proposed explicitly while new and original UUIDs remain separate',async()=>{
  const id=await server();await write(id,'8300F)');const old=await observation(id,'8300F)');
  const run=await write(id,'8301F)');const fresh=await observation(id,'8301F)');const operatorId=randomUUID();
  assert.notEqual(old.camera_id,fresh.camera_id);
  const p=await registerIdentityHypothesis(db,{kind:'possible_rename',serverRunId:run.serverRunId,bindingId:String(fresh.binding_id),relatedBindingId:String(old.binding_id),operatorId});
  assert.equal(p.kind,'possible_rename');assert.equal(p.state,'pending');
  const replay=await registerIdentityHypothesis(db,{kind:'possible_rename',serverRunId:run.serverRunId,bindingId:String(fresh.binding_id),relatedBindingId:String(old.binding_id),operatorId});
  assert.equal(replay.proposalId,p.proposalId);assert.equal(replay.created,false);
  assert.equal((await q('SELECT created_by FROM identity_proposals WHERE id=$1',[p.proposalId])).rows[0].created_by,operatorId);
  const names=(await q('SELECT external_name FROM camera_bindings WHERE server_id=$1 ORDER BY external_name',[id])).rows.map(r=>r.external_name);
  assert.deepEqual(names,['8300F)','8301F)']);
});
test('identity possible replacement with a new code is a hypothesis, never continuity of location',async()=>{
  const id=await server();await write(id,'8400F)');const old=await observation(id,'8400F)');
  await q("UPDATE cameras SET camera_number='8400',camera_type_code='F',identity_review='confirmed' WHERE id=$1",[old.camera_id]);
  const run=await write(id,'8401P)');const fresh=await observation(id,'8401P)');
  assert.equal((await q("SELECT count(*)::int AS n FROM identity_proposals WHERE camera_id=$1 AND kind='possible_replacement'",[fresh.camera_id])).rows[0].n,0);
  const p=await registerIdentityHypothesis(db,{kind:'possible_replacement',serverRunId:run.serverRunId,bindingId:String(fresh.binding_id),relatedBindingId:String(old.binding_id),operatorId:randomUUID()});
  assert.equal(p.kind,'possible_replacement');assert.equal(p.state,'pending');assert.notEqual(old.camera_id,fresh.camera_id);
  assert.equal((await observation(id,'8400F)')).camera_code,'8400F');assert.equal((await observation(id,'8401P)')).camera_code,null);
});
async function hypothesis(){
  const id=await server();await write(id,'8500F)');const old=await observation(id,'8500F)');const run=await write(id,'8501F)');const fresh=await observation(id,'8501F)');
  const operatorId=randomUUID();const p=await registerIdentityHypothesis(db,{kind:'possible_rename',serverRunId:run.serverRunId,
    bindingId:String(fresh.binding_id),relatedBindingId:String(old.binding_id),operatorId});
  return {p,operatorId,fresh,old,run};
}
test('identity review uses optimistic revisions and immutable operator audit',async()=>{
  const {p,operatorId}=await hypothesis();const key=randomUUID();
  const note=await reviewIdentityProposal(db,{proposalId:p.proposalId,requestKey:key,expectedRevision:'1',operatorId,action:'note',reasonCode:'requires_policy'});
  assert.equal(note.revision,'2');assert.equal(note.state,'pending');
  await assert.rejects(reviewIdentityProposal(db,{proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'1',operatorId:randomUUID(),action:'reject',reasonCode:'insufficient_evidence'}),error('REVISION_CONFLICT'));
  const rejection=await reviewIdentityProposal(db,{proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'2',operatorId,action:'reject',reasonCode:'incorrect_hypothesis'});
  assert.equal(rejection.revision,'3');assert.equal(rejection.state,'rejected');
  const replay=await reviewIdentityProposal(db,{proposalId:p.proposalId,requestKey:key,expectedRevision:'1',operatorId,action:'note',reasonCode:'requires_policy'});
  assert.equal(replay.decisionId,note.decisionId);assert.equal(replay.replayed,true);assert.equal(replay.revision,'2');
  const audit=(await q('SELECT operator_id,expected_revision,resulting_revision,reason_code,decided_at FROM identity_review_events WHERE proposal_id=$1 ORDER BY resulting_revision',[p.proposalId])).rows;
  const view=await readIdentityProposal(db,p.proposalId);assert.equal(view.applicationBlocked,true);assert.equal(view.proposal.state,'rejected');assert.equal(view.decisions.length,2);
  assert.equal(audit.length,2);assert.ok(audit.every(r=>r.operator_id===operatorId && r.decided_at!==null));
  await assert.rejects(q('DELETE FROM identity_review_events WHERE proposal_id=$1',[p.proposalId]));
  await assert.rejects(q("UPDATE identity_proposals SET state='approved' WHERE id=$1",[p.proposalId]));
  await assert.rejects(reviewIdentityProposal(db,{proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'3',operatorId,action:'note',reasonCode:'evidence_reviewed'}),error('REVIEW_CLOSED'));
});
test('identity decision request keys cannot be reused with an incompatible payload',async()=>{
  const {p,operatorId}=await hypothesis();const input={proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'1',operatorId,action:'note' as const,reasonCode:'evidence_reviewed' as const};
  await reviewIdentityProposal(db,input);
  await assert.rejects(reviewIdentityProposal(db,{...input,action:'reject'}),error('IDEMPOTENCY_CONFLICT'));
});
test('identity approval, resolution, application and automatic merging remain blocked',async()=>{
  const {p,operatorId,fresh,old}=await hypothesis();
  for(const action of ['approve','resolve','merge','apply'])await assert.rejects(reviewIdentityProposal(db,{
    proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'1',operatorId,action:action as never,reasonCode:'evidence_reviewed'}),error('POLICY_REQUIRED'));
  assert.throws(()=>applyIdentityProposal(db,{proposalId:p.proposalId,operatorId,expectedRevision:'1'}),error('POLICY_REQUIRED'));
  assert.notEqual(fresh.camera_id,old.camera_id);assert.equal((await q('SELECT state,revision FROM identity_proposals WHERE id=$1',[p.proposalId])).rows[0].state,'pending');
  assert.equal((await q('SELECT count(*)::int AS n FROM identity_review_events WHERE proposal_id=$1',[p.proposalId])).rows[0].n,0);
});
test('identity decision rollback restores both proposal revision and append-only audit',async()=>{
  const {p,operatorId}=await hypothesis();const input={proposalId:p.proposalId,requestKey:randomUUID(),expectedRevision:'1',operatorId,action:'reject' as const,reasonCode:'insufficient_evidence' as const};
  const broken:MigrationConnection={exec:s=>db.exec(s),query:async(s,args)=>{const result=await db.query(s,args);
    if(s.startsWith('INSERT INTO identity_review_events'))await db.exec('SELECT * FROM deliberately_missing_review_table');return result;}};
  await assert.rejects(reviewIdentityProposal(broken,input),error('PERSISTENCE_FAILED'));
  const stored=(await q('SELECT state,revision FROM identity_proposals WHERE id=$1',[p.proposalId])).rows[0];assert.equal(stored.state,'pending');assert.equal(String(stored.revision),'1');
  assert.equal((await q('SELECT count(*)::int AS n FROM identity_review_events WHERE proposal_id=$1',[p.proposalId])).rows[0].n,0);
  assert.equal((await reviewIdentityProposal(db,input)).state,'rejected');
});
test('identity detection failure rolls back the entire snapshot, including provisional UUID and evidence',async()=>{
  const a=await server(),b=await server();await write(a,'8600F)');const {e,o}=await prepare(b,'8600F)');
  const broken:MigrationConnection={exec:s=>db.exec(s),query:async(s,args)=>{const result=await db.query(s,args);
    if(s.startsWith('INSERT INTO identity_proposal_evidence'))await db.exec('SELECT * FROM deliberately_missing_detection_table');return result;}};
  await assert.rejects(writeServerSnapshot(broken,e,o),x=>x instanceof SnapshotWriterError && x.code==='PERSISTENCE_FAILED');
  assert.equal((await q('SELECT count(*)::int AS n FROM camera_bindings WHERE server_id=$1',[b])).rows[0].n,0);
  assert.equal((await q('SELECT count(*)::int AS n FROM identity_proposal_evidence WHERE server_run_id=$1',[e.serverRunId])).rows[0].n,0);
  assert.equal((await q('SELECT outcome FROM sync_server_runs WHERE id=$1',[e.serverRunId])).rows[0].outcome,'running');
  await writeServerSnapshot(db,e,o);assert.equal((await detectIdentityProposals(db,e.serverRunId)).length,1);
});
test('identity evidence cannot be fabricated from Description or attached to an older unobserved run',async()=>{
  const id=await server();const old=await write(id,'not-a-code');const obs=await observation(id,'not-a-code');await write(id,'new-name');
  await assert.rejects(detectIdentityProposals(db,old.serverRunId),error('STALE_OBSERVATION'));
  assert.equal((await q("SELECT identity_name_code('1390F)') AS code,identity_name_code('1390F)' || chr(10)) AS invalid")).rows[0].code,'1390F');
  assert.equal((await q("SELECT identity_name_code('1390F)' || chr(10)) AS code")).rows[0].code,null);
  const cases=(await q('SELECT observed_code FROM identity_proposals WHERE camera_id=$1',[obs.camera_id])).rows;
  assert.ok(cases.every(r=>r.observed_code===null));
  assert.equal((await q("SELECT count(*)::int AS n FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace AND confdeltype='c'")).rows[0].n,0);
});
test('003 upgrades 002 atomically, validates checksums, rolls back and reapplies',async()=>{
  const isolated=new PGlite({extensions:{btree_gist}});
  try{
    await isolated.exec('CREATE EXTENSION btree_gist');await migrate(isolated,'up','002_sync_observations');
    const checksums=(await isolated.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
    await isolated.exec("INSERT INTO nodes(code,name) VALUES ('synthetic-upgrade','Preserved')");
    const broken:MigrationConnection={query:(s,p)=>isolated.query(s,p),exec:s=>isolated.exec(s.startsWith('-- Review proposals only.')?s+'\nSELECT * FROM deliberately_missing_003_table;':s)};
    await assert.rejects(migrate(broken,'up'));
    assert.equal((await isolated.query("SELECT to_regclass('public.identity_proposals') AS table_name")).rows[0].table_name,null);
    assert.deepEqual((await isolated.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows,checksums);
    await migrate(isolated,'up');await migrate(isolated,'up');
    assert.equal((await isolated.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n,migrationIds.length);
    const original=(await isolated.query("SELECT checksum FROM schema_migrations WHERE id='003_identity_review'")).rows[0].checksum;
    await isolated.exec("UPDATE schema_migrations SET checksum='tamper' WHERE id='003_identity_review'");
    await assert.rejects(migrate(isolated,'up'),/Migration history/);await assert.rejects(migrate(isolated,'down'),/Migration history/);
    await isolated.query("UPDATE schema_migrations SET checksum=$1 WHERE id='003_identity_review'",[original]);
    await migrate(isolated,'down');await migrate(isolated,'down');await migrate(isolated,'up');await migrate(isolated,'down');
    assert.deepEqual((await isolated.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows,[{tablename:'schema_migrations'}]);
  }finally{await isolated.close();}
});
