import {migrationIds} from '../src/database/migrations.ts';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import type {TestContext} from 'node:test';
import {migrate,type MigrationConnection} from '../src/database/migrations.ts';
import {parseMunicipalDescription} from '../src/digifort/municipal-code-parser.ts';
import {associateCameras,parseInventoryJson,parseStatusJson} from '../src/digifort/json-parser.ts';
import {beginServerSync,writeServerSnapshot} from '../src/sync/snapshot-writer.ts';

/** Same acceptance suite for PGlite and an explicitly disposable native PostgreSQL 17. */
export async function descriptionIdentitySuite(t:TestContext,db:MigrationConnection){
 const q=(s:string,p?:unknown[])=>db.query(s,p);
 await migrate(db,'up','003_identity_review');
 const cameraId=randomUUID(),serverId=randomUUID(),bindingId=randomUUID();
 await q("INSERT INTO digifort_servers(id,config_key,name,endpoint_origin,enabled) VALUES ($1,$2,'Synthetic source upgrade','https://synthetic.invalid',true)",[serverId,randomUUID()]);
 await q("INSERT INTO cameras(id,camera_number,camera_type_code,identity_review) VALUES ($1,'012','F','confirmed')",[cameraId]);
 await q("INSERT INTO camera_bindings(id,camera_id,server_id,external_name,valid_from) VALUES ($1,$2,$3,'013F)',clock_timestamp()-interval '1 hour')",[bindingId,cameraId,serverId]);
 await q(`INSERT INTO camera_inventory_versions(camera_id,binding_id,valid_from,description_original,code_candidate,number_candidate,type_code_candidate,code_parse_status,code_parser_version)
  VALUES ($1,$2,clock_timestamp()-interval '1 hour','999D) Legacy description','013F','013','F','valid','name-v1')`,[cameraId,bindingId]);
 const runId=randomUUID(),globalId=randomUUID(),token=randomUUID(),legacyProposal=randomUUID();
 await q("INSERT INTO server_sync_control(server_id,issued_sequence,applied_sequence,lease_token,lease_until) VALUES ($1,1,1,$2,clock_timestamp()+interval '1 hour')",[serverId,token]);
 await q("INSERT INTO sync_runs(id,request_key,trigger,started_at,finished_at,outcome) VALUES ($1,$1,'manual',clock_timestamp(),clock_timestamp(),'partial')",[globalId]);
 await q(`INSERT INTO sync_server_runs(id,run_id,server_id,sequence,config_revision,lease_token,started_at,finished_at,applied_at,outcome,inventory_completeness)
  VALUES ($1,$2,$3,1,1,$4,clock_timestamp(),clock_timestamp(),clock_timestamp(),'partial','unknown')`,[runId,globalId,serverId,token]);
 await q('UPDATE camera_current_state SET binding_id=$2,applied_sequence=1 WHERE camera_id=$1',[cameraId,bindingId]);
 const inventoryId=(await q('SELECT id FROM camera_inventory_versions WHERE camera_id=$1',[cameraId])).rows[0].id;
 await q(`INSERT INTO identity_proposals(id,detection_key,detected_server_run_id,kind,camera_id,binding_id,inventory_id,observed_code,confirmed_code,source)
  VALUES ($1,$2,$3,'confirmed_code_mismatch',$4,$5,$6,'013F','012F','automatic')`,[legacyProposal,'0'.repeat(64),runId,cameraId,bindingId,inventoryId]);
 await q('UPDATE server_sync_control SET lease_token=NULL,lease_until=NULL WHERE server_id=$1',[serverId]);
 const before=(await q('SELECT * FROM camera_inventory_versions WHERE camera_id=$1',[cameraId])).rows;
 const checksums=(await q('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
 await t.test('004 upgrades legacy inventory without assigning, relabeling or rewriting evidence',async()=>{
  const broken:MigrationConnection={query:(s,p)=>q(s,p),exec:s=>db.exec(s.startsWith('-- Description becomes')?s+'\nSELECT * FROM deliberately_missing_004;':s)};
  await assert.rejects(migrate(broken,'up'));
  assert.deepEqual((await q('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows,checksums);
  await migrate(db,'up');await migrate(db,'up');
  assert.deepEqual((await q('SELECT * FROM camera_inventory_versions WHERE camera_id=$1',[cameraId])).rows,before);
  assert.equal((await q('SELECT camera_code FROM cameras WHERE id=$1',[cameraId])).rows[0].camera_code,'012F');
  const legacy=(await q('SELECT code_source,observed_code,confirmed_code,state FROM identity_proposals WHERE id=$1',[legacyProposal])).rows[0];
  assert.deepEqual(legacy,{code_source:'Name',observed_code:'013F',confirmed_code:'012F',state:'pending'});
  assert.deepEqual((await q("SELECT id,checksum FROM schema_migrations WHERE id<'004_description_identity' ORDER BY id")).rows,checksums);
 });
 await t.test('SQL and TypeScript parse Description identically, preserving boundaries and zeros',async()=>{
  const cases=[null,'',' ','\t','\u00a0','\ufeff','025D','025D) Avenida','025D Avenida','025D)Avenida','025D))','025Dextra','025d','Text 025D)','025D)\n','001X)','123','１２F)'];
  for(const value of cases){const expected=parseMunicipalDescription(value);const actual=(await q('SELECT municipal_description_code($1) AS code',[value])).rows[0];assert.equal(actual.code,expected.cameraCode,JSON.stringify(value));}
 });
 const write=async(name:string,description:string|null,id=serverId)=>{
  const execution=await beginServerSync(db,{serverId:id,requestKey:randomUUID()});
  const at=new Date().toISOString(),body=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
  const snapshot=associateCameras(parseInventoryJson(body([{Name:name,Description:description,Active:true}])),parseStatusJson(body([{Name:name,Active:true,Working:true}])),{serverId:id});
  const endpoints=[{endpoint:'GetCameras',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at},
   {endpoint:'GetStatus',outcome:'success',httpStatus:200,rowCount:1,completeness:'unknown',startedAt:at,finishedAt:at}] as const;
  await writeServerSnapshot(db,execution,{snapshot,endpoints});return execution;
 };
 await t.test('new Description observations retain exact text and preserve UUID and confirmed code',async()=>{
  const run=await write('013F)','025D)  Synthetic place  ');
  const v=(await q('SELECT * FROM camera_inventory_versions WHERE camera_id=$1 AND valid_to IS NULL',[cameraId])).rows[0];
  assert.equal(v.description_original,'025D)  Synthetic place  ');assert.equal(v.code_candidate,'025D');assert.equal(v.code_parser_version,'description-v1');
  assert.equal((await q('SELECT camera_id FROM camera_bindings WHERE id=$1',[bindingId])).rows[0].camera_id,cameraId);
  assert.equal((await q('SELECT camera_code FROM cameras WHERE id=$1',[cameraId])).rows[0].camera_code,'012F');
  const proposal=(await q("SELECT * FROM identity_proposals WHERE camera_id=$1 AND code_source='Description'",[cameraId])).rows[0];
  assert.equal(proposal.code_source,'Description');assert.equal(proposal.observed_code,'025D');assert.equal(proposal.confirmed_code,'012F');
  assert.equal(proposal.detected_server_run_id,run.serverRunId);
 });
 await t.test('missing Description never falls back to a code-bearing technical Name',async()=>{
  await write('9999F)',null);const v=(await q(`SELECT v.*,c.camera_code FROM camera_inventory_versions v JOIN cameras c ON c.id=v.camera_id
   JOIN camera_bindings b ON b.id=v.binding_id WHERE b.external_name='9999F)' AND v.valid_to IS NULL`)).rows[0];
  assert.equal(v.code_candidate,null);assert.equal(v.code_parse_status,'absent');assert.equal(v.camera_code,null);
 });
 await t.test('duplicates across different technical Names are detected from Description without merging',async()=>{
  const another=String((await q("INSERT INTO digifort_servers(config_key,name,endpoint_origin,enabled) VALUES ($1,'Other synthetic','https://other.invalid',true) RETURNING id",[randomUUID()])).rows[0].id);
  await write('entirely different technical Name','025D Other place',another);
  const p=(await q("SELECT * FROM identity_proposals WHERE kind='duplicate_code' AND observed_code='025D'")).rows;
  assert.ok(p.length>0);assert.ok(p.every(row=>row.code_source==='Description'));
  assert.notEqual(p[0].camera_id,p[0].related_camera_id);
 });
 await t.test('SQL rejects forged candidate columns and guarded partial downgrade preserves provenance',async()=>{
  const columns=(await q('SELECT * FROM camera_inventory_versions WHERE camera_id=$1 AND valid_to IS NULL',[cameraId])).rows[0];
  await assert.rejects(q(`INSERT INTO camera_inventory_versions(camera_id,binding_id,valid_from,valid_to,description_original,code_candidate,number_candidate,type_code_candidate,code_parse_status,code_parser_version)
   VALUES ($1,$2,'2000-01-01','2000-01-02','025D)','777F','777','F','valid','description-v1')`,[columns.camera_id,columns.binding_id]),e=>typeof e==='object'&&e!==null&&'code' in e&&e.code==='23514');
  const down=await readFile(new URL('../migrations/004_description_identity.down.sql',import.meta.url),'utf8');
  await assert.rejects(db.exec(down));assert.equal((await q('SELECT camera_code FROM cameras WHERE id=$1',[cameraId])).rows[0].camera_code,'012F');
 });
 await t.test('full disposable-schema rollback and reapplication remain transactional and idempotent',async()=>{
  await migrate(db,'down');await migrate(db,'down');await migrate(db,'up');await migrate(db,'up');
  assert.equal((await q('SELECT count(*)::int n FROM cameras')).rows[0].n,0);
  assert.equal((await q('SELECT count(*)::int n FROM schema_migrations')).rows[0].n,migrationIds.length);
 });
}
