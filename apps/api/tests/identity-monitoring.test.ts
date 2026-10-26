import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {migrate} from '../src/database/migrations.ts';
import {seedDemoData,fixtureId} from './fixtures/demo.ts';
import {monitoringRepository} from '../src/monitor/repository.ts';
import {buildApp} from '../src/app.ts';
let db:PGlite,app:ReturnType<typeof buildApp>;
const root='/api/v1/monitor/identities';
before(async()=>{db=new PGlite({extensions:{btree_gist}});await db.exec('CREATE EXTENSION btree_gist');await migrate(db,'up');await seedDemoData(db);app=buildApp({monitoring:monitoringRepository(db)});});
after(async()=>{await app?.close();await db?.close();});
test('identity queue combines persisted proposals and current unconfirmed inventory',async()=>{
 const r=await app.inject(root);assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'no-store');
 const p=r.json();assert.equal(p.readOnly,true);assert.equal(p.total,9);
 assert.deepEqual(p.items.reduce((counts:Record<string,number>,x:{kind:string})=>({...counts,[x.kind]:(counts[x.kind]??0)+1}),{}),{
  unconfirmed_code:3,duplicate_code:2,confirmed_code_mismatch:2,possible_rename:1,possible_replacement:1});
 assert.ok(!r.body.includes('digifort.invalid'));assert.ok(!r.body.includes('endpoint_origin'));assert.ok(!r.body.includes('credential'));
});
test('candidate identity is Description-only, delimiter-free, separate from confirmed codes',async()=>{
 const p=(await app.inject(root)).json();const mismatch=p.items.find((x:{cameraId:string})=>x.cameraId===fixtureId(1030));
 assert.equal(mismatch.name,'9090F)');assert.equal(mismatch.candidateCode,'9090F');assert.equal(mismatch.confirmedCode,'1420D');
 const provisional=p.items.filter((x:{kind:string})=>x.kind==='unconfirmed_code');assert.ok(provisional.every((x:{confirmedCode:unknown;candidateCode:unknown;stateSource:string})=>x.confirmedCode===null&&x.candidateCode===null&&x.stateSource==='derived'));
 const r=(await app.inject(root+'/u-'+fixtureId(1007))).json();assert.equal(r.candidateCode,null);
 const camera=(await app.inject('/api/v1/monitor/cameras/'+fixtureId(1007))).json();assert.ok(camera.description.includes('9999F)'));
});
test('identity filters, pagination and empty results retain accurate totals',async()=>{
 assert.equal((await app.inject(root+'?kind=duplicate_code')).json().total,2);
 const s=(await app.inject(root+'?server='+fixtureId(101))).json();assert.ok(s.items.every((x:{serverId:string})=>x.serverId===fixtureId(101)));
 assert.equal((await app.inject(root+'?state=rejected')).json().total,0);
 assert.equal((await app.inject(root+'?state=pending&pageSize=2&page=2')).json().items.length,2);
 const empty=(await app.inject(root+'?page=100')).json();assert.equal(empty.total,9);assert.deepEqual(empty.items,[]);
});
test('evidence exposes linked provenance, original Name and bounded audit metadata',async()=>{
 const p=(await app.inject(root+'?kind=duplicate_code')).json().items[0];const r=await app.inject(root+'/'+p.id);assert.equal(r.statusCode,200);
 const detail=r.json();assert.equal(detail.applicationBlocked,true);assert.ok(detail.relatedCameraId);assert.ok(detail.evidence.length>0);
 assert.equal(detail.evidence[0].code,'IDENTITY_CONFLICT');assert.ok(detail.evidence[0].serverRunId);assert.deepEqual(detail.decisions,[]);
 const u=(await app.inject(root+'/u-'+fixtureId(1007))).json();assert.equal(u.evidence[0].code,'CAMERA_CODE_INVALID');
});
test('repeated reads cannot change UUID, confirmed identities, state history or decisions',async()=>{
 const snapshot=async()=>JSON.stringify((await db.query(`SELECT (SELECT json_agg(c ORDER BY id) FROM cameras c) AS cameras,
  (SELECT count(*) FROM camera_state_changes) AS history,(SELECT count(*) FROM identity_review_events) AS decisions,
  (SELECT count(*) FROM sync_issues) AS issues,(SELECT count(*) FROM identity_proposals) AS proposals`)).rows);
 const before=await snapshot();for(let i=0;i<3;i++)await app.inject(root);
 for(const method of ['POST','PATCH','DELETE'] as const)assert.equal((await app.inject({method,url:root,body:{action:'approve'}})).statusCode,404);
 assert.equal(await snapshot(),before);
});
test('invalid filters and IDs fail safely; database errors are sanitized',async()=>{
 for(const path of ['?kind=merge','?state=unsafe','?server=bad','?page=0','?pageSize=101','/bad'])assert.equal((await app.inject(root+path)).statusCode,400);
 assert.equal((await app.inject(root+'/p-00000000-0000-4000-8000-000000000000')).statusCode,404);
 const broken=buildApp({monitoring:monitoringRepository({query:async()=>{throw new Error('private password');}})});
 try{for(const path of ['', '/u-'+fixtureId(1007)]){const r=await broken.inject(root+path);assert.equal(r.statusCode,503);assert.ok(!r.body.includes('password'));}}finally{await broken.close();}
});

test('unbound provisional cameras remain visible without invented evidence or identity',async()=>{
 await db.exec('BEGIN');try{
  await db.query("INSERT INTO cameras(id,identity_review) VALUES ($1,'provisional')",[fixtureId(19999)]);
  const r=await app.inject(root+'/u-'+fixtureId(19999));assert.equal(r.statusCode,200);
  const x=r.json();assert.equal(x.candidateCode,null);assert.equal(x.serverId,null);assert.equal(x.inventoryId,null);assert.equal(x.evidenceCount,0);
 }finally{await db.exec('ROLLBACK');}
});
