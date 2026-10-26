import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.ts';
import {createInspectionService} from '../src/inspection/service.ts';
const config={id:'private-id',baseUrl:'https://synthetic.invalid:9443',username:'synthetic-user',password:'synthetic-password'};
const origin='http://127.0.0.1:8083';
const rows=[{Name:'1390F) Suarez y Solis',Description:'  Original description\nkept intact  '},
 {Name:'025D',Description:'Independent'}, {Name:'Cruce 42 con 1390F',Description:'9999P)'},
 {Name:null,Description:null},{Name:'001X) Avenida',Description:'Unknown type'},
 {Name:'<script>alert(1)</script>',Description:'<img src=x onerror=alert(1)>'}];
function setup(fetch:typeof globalThis.fetch,now?:()=>number){
 const service=createInspectionService({server:config,fetch,now});
 const app=buildApp({logger:false,inspection:{service,origin}});
 const get=()=>app.inject({url:'/api/v1/inspection',headers:{host:'127.0.0.1:8083'}});
 const query=(extra:Record<string,string>={})=>app.inject({method:'POST',url:'/api/v1/inspection/query',headers:{host:'127.0.0.1:8083',origin,'x-digifort-inspection':'manual',...extra},payload:{serverId:'selected'}});
 return {app,service,get,query};
}
test('inspection GETs never contact Digifort; a manual POST emits exactly one whitelisted GET',async()=>{
 let calls=0;
 const s=setup(async(input,init)=>{calls++;const url=new URL(String(input));assert.equal(url.origin,config.baseUrl);
  assert.equal(url.pathname,'/Interface/Cameras/GetCameras');assert.equal(url.searchParams.get('ResponseFormat'),'JSON');
  assert.equal(url.searchParams.get('AuthUser'),config.username);assert.equal(url.searchParams.get('AuthPass'),config.password);
  assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  return new Response(JSON.stringify({Response:{Data:{Cameras:rows}}}));
 });
 try{
  assert.equal((await s.get()).json().snapshot,null);assert.equal(calls,0);
  const response=await s.query();assert.equal(response.statusCode,200);const result=response.json();
  assert.equal(result.inFlight,false);assert.equal(result.snapshot.total,6);assert.deepEqual(result.snapshot.counts,{valid:2,invalid:2,absent:1,unknown_type:1});
  assert.equal(result.snapshot.rows[0].name,rows[0].Name);assert.equal(result.snapshot.rows[0].description,rows[0].Description);
  assert.equal(result.snapshot.rows[1].cameraNumber,'025');assert.equal(result.snapshot.rows[2].cameraCode,null);
  assert.ok(result.snapshot.rows.filter((r:{status:string})=>r.status!=='valid').every((r:{reason:string})=>r.reason.length>0));
  assert.equal(response.headers['cache-control'],'no-store');
  for(const secret of [config.username,config.password,config.baseUrl,'ConnectionAddress','Memo'])assert.ok(!response.body.includes(secret));
  await s.get();await s.get();assert.equal(calls,1);
  assert.equal((await s.app.inject('/api/v1/monitor/cameras')).statusCode,404);
 }finally{await s.app.close();}
});
test('inspection rejects cross-origin, rebinding, missing manual marker and arbitrary target selection',async()=>{
 let calls=0;const s=setup(async()=>{calls++;return new Response('{}');});
 try{
  assert.equal((await s.query({origin:'https://outside.invalid'})).statusCode,403);
  assert.equal((await s.query({host:'outside.invalid:8083'})).statusCode,403);
  assert.equal((await s.query({'x-digifort-inspection':''})).statusCode,403);
  for(const payload of [{serverId:'other'},{serverId:'selected',url:'https://other.invalid'}]){
   const r=await s.app.inject({method:'POST',url:'/api/v1/inspection/query',headers:{host:'127.0.0.1:8083','x-digifort-inspection':'manual'},payload});assert.equal(r.statusCode,400);
  }
  assert.equal(calls,0);
 }finally{await s.app.close();}
});
test('concurrent manual actions cannot duplicate the in-flight request',async()=>{
 let release!:()=>void,calls=0;const gate=new Promise<void>(r=>{release=r;});
 const s=setup(async()=>{calls++;await gate;return new Response('{"Response":{"Data":{"Cameras":[]}}}');});
 try{
  const first=s.service.query();await new Promise(r=>setTimeout(r,0));
  assert.equal((await s.query()).statusCode,409);assert.equal(calls,1);release();await first;
 }finally{release();await s.app.close();}
});
test('snapshot expires in RAM without a new remote request',async()=>{
 let now=Date.now(),calls=0;const s=setup(async()=>{calls++;return new Response('{"Response":{"Data":{"Cameras":[]}}}');},()=>now);
 try{await s.query();now+=31*60*1000;assert.equal((await s.get()).json().snapshot,null);assert.equal(calls,1);}
 finally{await s.app.close();}
});
test('failed read preserves the original observation and sanitizes errors without retries',async()=>{
 let calls=0;const s=setup(async()=>{calls++;if(calls===1)return new Response(JSON.stringify({Response:{Data:{Cameras:rows}}}));throw Error('private password URL');});
 try{await s.query();const prior=(await s.get()).json().snapshot;const r=await s.query();assert.equal(r.statusCode,502);assert.equal(r.json().code,'NETWORK_ERROR');
  assert.ok(!r.body.includes('password'));assert.deepEqual((await s.get()).json().snapshot,prior);assert.equal(calls,2);
 }finally{await s.app.close();}
});
test('HTTP errors, invalid envelopes, malformed fields and oversized responses remain bounded',async()=>{
 for(const [body,expected,status] of [['{}','INVALID_RESPONSE',200],['not json','INVALID_JSON',200],['private failure','HTTP_ERROR',401],
  [JSON.stringify({Response:{Data:{Cameras:[{Name:42}]}}}),'INVALID_RESPONSE',200],['x'.repeat(1048577),'RESPONSE_TOO_LARGE',200]] as const){
  let calls=0;const s=setup(async()=>{calls++;return new Response(body,{status});});
  try{const r=await s.query();assert.equal(r.statusCode,502);assert.equal(r.json().code,expected);assert.equal(calls,1);assert.equal((await s.get()).json().snapshot,null);}
  finally{await s.app.close();}
 }
});
