const {test}=require('node:test');const assert=require('node:assert/strict');const {randomBytes}=require('node:crypto');
const jwt=require('jsonwebtoken');const {createApp}=require('../app.cjs');const {mapCameras}=require('../mapper.cjs');const {createCollector,allowedNetworks}=require('../collector.cjs');
const {createSecurity,hashPassword}=require('../../../packages/security/index.cjs');
test('legacy CameraId extraction and fields remain compatible; diagnostic flags are additive',()=>{
 const c=mapCameras([{Name:'technical',Description:'0042f) Synthetic place',Active:true,ConnectionAddress:'192.0.2.10'}],[{Name:'technical',Active:true,Working:false}],{ServerId:'s',ServerName:'Synthetic',ServerIp:'192.0.2.1'},[{NodoId:'2',NodoName:'Synthetic node'}])[0];
 assert.equal(c.CameraId,'0042');assert.equal(c.CameraType,'Fija');assert.equal(c.NodoName,'Synthetic node');assert.equal(c.Working,false);assert.equal(c.StatusWorking,false);
 assert.equal(mapCameras([{Name:'x',Description:'0042F'}],[],{ServerName:'s'})[0].CameraId,'');
});
test('collector reads enabled servers from SQL and sanitizes independent failures',async()=>{
 const db={query:async sql=>{assert.match(sql,/WHERE enabled AND retired_at IS NULL/);return {rows:[{id:'a',name:'A',endpoint_origin:'http://192.0.2.1:8601',credential_ref:'p'},{id:'b',name:'B',endpoint_origin:'http://192.0.2.2:8601',credential_ref:'missing'}]};}};
 let calls=0;const collector=createCollector({db,profiles:{p:{username:'synthetic',password:'synthetic-secret'}},request:async endpoint=>{calls++;return {Response:{Data:{Cameras:endpoint==='GetCameras'?[{Name:'x',Description:'0042F)'}]:[{Name:'x',Active:true,Working:true}]}}};}});
 const result=await collector.all();assert.equal(calls,2);assert.equal(result.data[0].CameraId,'0042');assert.equal(result.servers[1].errorCode,'CREDENTIAL_PROFILE');assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
 assert.ok(allowedNetworks('192.0.2.0/24').allows('192.0.2.1'));assert.equal(allowedNetworks('192.0.2.0/24').allows('127.0.0.1'),false);
});
test('database login and JWT preserve camera endpoint shapes while unknown status is excluded from down',async()=>{
 const id='00000000-0000-4000-8000-000000000001',hash=await hashPassword('synthetic-test-password');
 const db={query:async()=>({rows:[{id,username:'synthetic',password_hash:hash,role:'viewer',enabled:true,auth_version:1}]})};
 const userTokens=createSecurity(jwt,randomBytes(48).toString('hex'),'monitor-users'),serviceTokens=createSecurity(jwt,randomBytes(48).toString('hex'),'apicamstat');
 const collector={all:async()=>({data:[{CameraId:'0042',Active:true,Working:false,StatusActive:true,StatusWorking:null,StatusCoverage:'missing'}],servers:[]})};
 const app=await createApp({db,collector,userTokens,serviceTokens});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/cameras')).status,401);const login=await(await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'synthetic',password:'synthetic-test-password'})})).json();assert.ok(login.token);assert.equal(login.expiresIn,'1h');
 const headers={Authorization:'Bearer '+login.token};const cameras=await(await fetch(base+'/cameras',{headers})).json();assert.equal(cameras.total,1);assert.ok(Array.isArray(cameras.data));
 const down=await(await fetch(base+'/cameras/down',{headers})).json();assert.equal(down.total,0);
 assert.equal((await fetch(base+'/cameras',{headers:{Authorization:'Bearer invalid'}})).status,403);
 }finally{await new Promise(r=>server.close(r));}
});
