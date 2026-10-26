import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {migrate} from '../src/database/migrations.ts';
import {seedDemoData} from './fixtures/demo.ts';
import {monitoringRepository} from '../src/monitor/repository.ts';
import {buildApp} from '../src/app.ts';
let db:PGlite,app:ReturnType<typeof buildApp>;
before(async()=>{db=new PGlite({extensions:{btree_gist}});await db.exec('CREATE EXTENSION btree_gist');await migrate(db,'up');await seedDemoData(db);
  app=buildApp({monitoring:monitoringRepository(db)});});
after(async()=>{await app?.close();await db?.close();});
test('demo summary classifies fresh, stale, inactive and server failures independently',async()=>{
  const r=await app.inject('/api/v1/monitor/overview');assert.equal(r.statusCode,200);
  const s=r.json();assert.equal(s.total,48);assert.equal(s.operational,24);assert.equal(s.down,3);assert.equal(s.inactive,3);assert.equal(s.unknown,18);
  assert.equal(s.serversWithProblems,2);assert.equal(s.total,s.operational+s.down+s.inactive+s.unknown);
  assert.ok(!r.body.includes('endpoint_origin'));assert.ok(!r.body.includes('digifort.invalid'));
});
test('demo lists real persisted rows with search, filters and accurate pagination totals',async()=>{
  const page=(await app.inject('/api/v1/monitor/cameras?pageSize=5&page=2')).json();assert.equal(page.items.length,5);assert.equal(page.total,48);
  const down=(await app.inject('/api/v1/monitor/cameras?status=down')).json();assert.equal(down.total,3);
  assert.ok(down.items.every((c:{active:boolean;working:boolean;quality:string})=>c.active===true&&c.working===false&&c.quality==='down'));
  const searched=(await app.inject('/api/v1/monitor/cameras?q=1390D')).json();assert.equal(searched.total,2);assert.equal(searched.items[0].name,'1390D)');
  const empty=(await app.inject('/api/v1/monitor/cameras?page=100')).json();assert.equal(empty.total,48);assert.equal(empty.items.length,0);
  const literal=(await app.inject('/api/v1/monitor/cameras?q=%25')).json();assert.equal(literal.total,0);
});
test('provisional cameras have NULL confirmed codes and detail history preserves independent flags',async()=>{
  const page=(await app.inject('/api/v1/monitor/cameras?q=DEMO-PROVISIONAL')).json();assert.equal(page.total,3);
  assert.ok(page.items.every((c:{cameraCode:null})=>c.cameraCode===null));
  const detail=(await app.inject('/api/v1/monitor/cameras/'+page.items[0].id)).json();assert.equal(detail.cameraCode,null);
  assert.ok(detail.events.length>=2);assert.ok(detail.events.every((e:{active:unknown;working:unknown})=>typeof e.active==='boolean'&&(e.working===null||typeof e.working==='boolean')));
});
test('server outage preserves camera Working but current classification is unknown',async()=>{
  const servers=(await app.inject('/api/v1/monitor/servers')).json().items;
  const offline=servers.find((s:{health:string})=>s.health==='unreachable');const degraded=servers.find((s:{query:string})=>s.query==='auth_error');
  assert.ok(offline);assert.equal(degraded.transport,'responding');
  const cameras=(await app.inject('/api/v1/monitor/cameras?server='+offline.id)).json();
  assert.equal(cameras.total,4);assert.ok(cameras.items.every((c:{status:string;working:boolean;quality:string})=>c.status==='unknown'&&c.working===true&&c.quality==='server_problem'));
});
test('future observations or missing coverage cannot be classified as down',async()=>{
  await db.exec('BEGIN');
  try{
    const id=(await db.query("SELECT camera_id FROM camera_current_state WHERE working=false LIMIT 1")).rows[0].camera_id;
    await db.query("UPDATE camera_current_state SET last_snapshot_success_at=clock_timestamp()+interval '1 hour' WHERE camera_id=$1",[id]);
    const detail=(await app.inject('/api/v1/monitor/cameras/'+id)).json();assert.equal(detail.status,'unknown');
  }finally{await db.exec('ROLLBACK');}
});
test('read API validates filters and identifiers and sanitizes database failures',async()=>{
  for(const path of ['cameras?server=bad','cameras?status=invalid','cameras?page=0','cameras?pageSize=1000','cameras/bad'])assert.equal((await app.inject('/api/v1/monitor/'+path)).statusCode,400);
  assert.equal((await app.inject('/api/v1/monitor/cameras/00000000-0000-4000-8000-000000000000')).statusCode,404);
  const broken=buildApp({monitoring:monitoringRepository({query:async()=>{throw new Error('private database password');}})});
  try{const response=await broken.inject('/api/v1/monitor/overview');assert.equal(response.statusCode,503);assert.ok(!response.body.includes('password'));}finally{await broken.close();}
  const disabled=buildApp();try{assert.equal((await disabled.inject('/api/v1/monitor/overview')).statusCode,404);}finally{await disabled.close();}
});
test('seed refuses to overwrite an existing inventory',async()=>{await assert.rejects(seedDemoData(db),/empty inventory/);});
