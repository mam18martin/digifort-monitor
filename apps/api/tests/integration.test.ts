import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {migrate} from '../src/database/migrations.ts';
import {hashPassword,verifyPassword,createSecurity} from '../../../packages/security/index.cjs';
import {serverRepository} from '../src/integration/repository.ts';
import {apicamstatClient} from '../src/integration/client.ts';
import {integrationCameraService} from '../src/integration/camera-service.ts';
import {buildApp} from '../src/app.ts';
let db:PGlite,admin:string,viewer:string;
const tokens=createSecurity(jwt,randomBytes(48).toString('base64'),'monitor-users');
before(async()=>{db=new PGlite({extensions:{btree_gist}});await db.exec('CREATE EXTENSION btree_gist');await migrate(db,'up');
 const hash=await hashPassword('synthetic-test-password');
 admin=String((await db.query("INSERT INTO app_users(username,password_hash,role) VALUES ('synthetic-admin',$1,'admin') RETURNING id",[hash])).rows[0].id);
 viewer=String((await db.query("INSERT INTO app_users(username,password_hash,role) VALUES ('synthetic-viewer',$1,'viewer') RETURNING id",[hash])).rows[0].id);
});after(async()=>{await db?.close();});
const input={name:'Synthetic server',address:'192.0.2.10',protocol:'http',port:8601,credentialRef:'synthetic-profile',enabled:false};
test('secure salted password hashes verify and reject invalid passwords',async()=>{
 const a=await hashPassword('synthetic-test-password'),b=await hashPassword('synthetic-test-password');assert.notEqual(a,b);
 assert.ok(await verifyPassword('synthetic-test-password',a));assert.equal(await verifyPassword('wrong',a),false);
 await assert.rejects(hashPassword('short'));assert.ok(!a.includes('synthetic-test-password'));
});
test('server CRUD is audited, revision-controlled, logically retired and rejects camera changes',async()=>{
 const repo=serverRepository(db,['synthetic-profile']);const created=await repo.create(input,admin);assert.equal(created.enabled,false);assert.equal(created.port,8601);
 const updated=await repo.update(String(created.id),{...input,name:'Changed',enabled:true,revision:String(created.revision)},admin);assert.equal(updated.revision,'2');
 await assert.rejects(repo.update(String(created.id),{...input,revision:'1'},admin),/REVISION_CONFLICT/);
 const retired=await repo.retire(String(created.id),'2',admin);assert.ok(retired.retiredAt);assert.equal(retired.enabled,false);
 assert.equal((await db.query('SELECT count(*)::int n FROM server_admin_events WHERE server_id=$1',[created.id])).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int n FROM cameras')).rows[0].n,0);
 await assert.rejects(repo.create({...input,password:'must-not-be-stored'},admin),/INVALID_REQUEST/);
 await assert.rejects(repo.create({...input,credentialRef:'unconfigured'},admin),/INVALID_REQUEST/);
 const count=(await repo.list()).length;await assert.rejects(repo.create(input,randomUUID()));assert.equal((await repo.list()).length,count);
});
test('login/session cookies and server administration enforce current database roles',async()=>{
 const client={login:async(username:string,_password:string)=>({token:tokens.sign({sub:username==='viewer'?viewer:admin,ver:1,role:'admin'}),expiresIn:'1h'}),cameras:async()=>({total:0,data:[],servers:[]})};
 const app=buildApp({logger:false,integration:{db,client,tokens,origin:'http://127.0.0.1:8085',profiles:['synthetic-profile']}});
 const headers={host:'127.0.0.1:8085','x-monitor-action':'manual'};
 const cookie=(id:string)=>'monitor_session='+tokens.sign({sub:id,ver:1,role:'admin'});
 try{
  assert.equal((await app.inject({url:'/api/admin/servers',headers})).statusCode,401);
  assert.equal((await app.inject({url:'/api/admin/servers',headers:{...headers,cookie:cookie(viewer)}})).statusCode,403);
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers,payload:{username:'admin',password:'synthetic-test-password'}});
  assert.equal(login.statusCode,200);assert.match(String(login.headers['set-cookie']),/HttpOnly/);assert.match(String(login.headers['set-cookie']),/SameSite=Strict/);assert.ok(!login.body.includes('token'));
  const session=await app.inject({url:'/api/auth/session',headers:{...headers,cookie:cookie(admin)}});assert.equal(session.json().user.role,'admin');
  const created=await app.inject({method:'POST',url:'/api/admin/servers',headers:{...headers,cookie:cookie(admin)},payload:input});assert.equal(created.statusCode,201);
  assert.equal((await app.inject({url:'/api/admin/servers',headers:{...headers,cookie:cookie(admin),origin:'https://outside.invalid'}})).statusCode,403);
  await db.query('UPDATE app_users SET enabled=false WHERE id=$1',[viewer]);assert.equal((await app.inject({url:'/api/v1/live',headers:{...headers,cookie:cookie(viewer)}})).statusCode,401);
 }finally{await app.close();}
});
test('backend consumes apicamstat only, retains its CameraId and does not derive municipal identity',async()=>{
 const calls:string[]=[];const remote=apicamstatClient({origin:'http://apicamstat:3001',serviceToken:()=> 'synthetic-service-token',fetch:async(input,init)=>{
  calls.push(String(input));assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer synthetic-service-token');
  return new Response(JSON.stringify({total:1,data:[{CameraId:'0042',CameraType:'Fija',Name:'technical Name',Description:'9999D) do not reparse',ServerId:'s1',ServerName:'Synthetic',StatusActive:true,StatusWorking:true,StatusCoverage:'matched',Model:'Synthetic'}],servers:[{serverId:'s1',name:'Synthetic',outcome:'success',errorCode:null,observedAt:new Date().toISOString(),durationMs:1}]}));
 }});
 const service=integrationCameraService(remote);try{await service.refresh();const camera=service.current().cameras[0];assert.equal(camera.cameraCode,'0042');assert.equal(camera.cameraTypeCode,'Fija');assert.equal(calls.length,1);assert.equal(calls[0],'http://apicamstat:3001/cameras');assert.deepEqual(camera.events,[]);}finally{service.close();}
});
test('005 idempotence, existing migration checksums and full isolated rollback',async()=>{
 const isolated=new PGlite({extensions:{btree_gist}});try{await isolated.exec('CREATE EXTENSION btree_gist');await migrate(isolated,'up','004_description_identity');
 const old=(await isolated.query('SELECT id,checksum FROM schema_migrations ORDER BY id')).rows;
 await migrate(isolated,'up');await migrate(isolated,'up');assert.deepEqual((await isolated.query("SELECT id,checksum FROM schema_migrations WHERE id<>'005_apicamstat_management' ORDER BY id")).rows,old);
 await migrate(isolated,'down');await migrate(isolated,'up');assert.equal((await isolated.query('SELECT count(*)::int n FROM app_users')).rows[0].n,0);
 }finally{await isolated.close();}
});

test('apicamstat future observations cannot classify a camera as down',async()=>{
 const service=integrationCameraService({login:async()=>({token:'unused',expiresIn:'1h'}),cameras:async()=>({total:1,data:[{CameraId:'0042',CameraType:'Fija',Name:'technical',Description:'0042F)',ServerId:'s1',ServerName:'Synthetic',StatusActive:true,StatusWorking:false,StatusCoverage:'matched',Model:'Synthetic'}],servers:[{serverId:'s1',name:'Synthetic',outcome:'success',errorCode:null,observedAt:new Date(Date.now()+3600000).toISOString(),durationMs:1}]})});
 try{await service.refresh();assert.equal(service.current().summary.down,0);assert.equal(service.current().summary.unknown,1);}finally{service.close();}
});
