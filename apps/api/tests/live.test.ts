import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLiveService} from '../src/live/service.ts';
import {buildApp} from '../src/app.ts';
const server={id:'synthetic',baseUrl:'https://synthetic.invalid',username:'synthetic-user',password:'synthetic-secret'};
const inventory=[{Name:'technical Name',Description:'025D)  Original description  ',Active:false,Model:'Synthetic model'}];
const states=(active:boolean|null=true,working:boolean|null=true)=>[{Name:'technical Name',Active:active,Working:working}];
const body=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
function setup(){let now=Date.now(),calls:string[]=[],inv:unknown[]=inventory,status:unknown[]=states(),fail='';
 const fetch:typeof globalThis.fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');
  const name=url.pathname.split('/').pop()!;calls.push(name);assert.ok(['GetCameras','GetStatus'].includes(name));assert.equal(url.origin,server.baseUrl);
  if(fail===name)return new Response('private remote error',{status:401});return new Response(body(name==='GetCameras'?inv:status));};
 const service=createLiveService({server,fetch,now:()=>now});
 return {service,calls,setStatus:(s:unknown[])=>{status=s;},setInventory:(s:unknown[])=>{inv=s;},setFailure:(s:string)=>{fail=s;},advance:(ms:number)=>{now+=ms;}};
}
test('live startup and reads perform no requests; refresh reads each endpoint once and keeps history empty',async()=>{
 const s=setup();try{assert.equal(s.service.current().summary.total,0);s.service.current();assert.equal(s.calls.length,0);
  const d=await s.service.refresh();assert.deepEqual(s.calls.sort(),['GetCameras','GetStatus']);assert.equal(d.source,'real');assert.equal(d.storage,'memory');
  assert.equal(d.summary.total,1);assert.equal(d.summary.operational,1);const c=d.cameras[0];assert.equal(c.cameraCode,'025D');assert.equal(c.cameraNumber,'025');
  assert.equal(c.name,inventory[0].Name);assert.equal(c.description,inventory[0].Description);assert.equal(c.active,true);assert.equal(c.inventoryActive,false);assert.deepEqual(c.events,[]);
  assert.ok(!JSON.stringify(d).includes(server.password));assert.ok(!JSON.stringify(d).includes(server.baseUrl));
  s.service.current();assert.equal(s.calls.length,2);
 }finally{s.service.close();}
});
test('real down classification needs valid recent status; expired observations become unknown',async()=>{
 const s=setup();try{s.setStatus(states(true,false));let d=await s.service.refresh();assert.equal(d.summary.down,1);
  s.advance(180001);d=s.service.current();assert.equal(d.summary.down,0);assert.equal(d.summary.unknown,1);assert.equal(d.cameras[0].working,false);assert.equal(d.server.health,'stale');
  s.advance(1800000);assert.equal(s.service.current().cameras.length,0);
 }finally{s.service.close();}
});
test('independent endpoint failures retain flags and classify communication problems instead of camera outages',async()=>{
 for(const endpoint of ['GetCameras','GetStatus']){const s=setup();try{
  await s.service.refresh();s.setFailure(endpoint);const d=await s.service.refresh();assert.equal(d.summary.down,0);assert.equal(d.summary.unknown,1);
  assert.equal(d.cameras[0].working,true);assert.equal(d.server.health,'degraded');assert.equal(d.server.endpoints.find(e=>e.endpoint===endpoint)?.httpStatus,401);
  assert.ok(d.server.lastSuccessAt);assert.equal(s.calls.length,4);
 }finally{s.service.close();}}
});
test('valid inventory is usable when the first status request fails; no Active fallback is used',async()=>{
 const s=setup();try{s.setFailure('GetStatus');const d=await s.service.refresh();assert.equal(d.summary.total,1);assert.equal(d.cameras[0].active,null);assert.equal(d.cameras[0].working,null);assert.equal(d.summary.unknown,1);}
 finally{s.service.close();}
});
test('NULL states and missing coverage remain unknown; absent cameras are retained without deletion',async()=>{
 const s=setup();try{await s.service.refresh();s.setStatus(states(null,null));let d=await s.service.refresh();assert.equal(d.cameras[0].active,null);assert.equal(d.cameras[0].working,null);assert.equal(d.summary.unknown,1);
  s.setStatus([]);d=await s.service.refresh();assert.equal(d.cameras[0].coverage,'missing');assert.equal(d.summary.down,0);
  s.setInventory([]);d=await s.service.refresh();assert.equal(d.summary.total,1);assert.equal(d.cameras[0].presentInLastInventory,false);assert.equal(d.cameras[0].status,'unknown');
 }finally{s.service.close();}
});
test('only actual subsequent semantic changes add history; IDs remain stable and FPS adds no transition',async()=>{
 const s=setup();try{const first=await s.service.refresh();await s.service.refresh();assert.equal(s.service.current().cameras[0].events.length,0);
  s.setStatus(states(true,false));let d=await s.service.refresh();assert.equal(d.cameras[0].events.length,1);assert.equal(d.cameras[0].id,first.cameras[0].id);assert.equal(d.cameras[0].events[0].before.working,true);
  s.setStatus([{...states(true,false)[0],RecordingFPS:99}]);d=await s.service.refresh();assert.equal(d.cameras[0].events.length,1);
  d.cameras[0].events[0].before.working=false;assert.equal(s.service.current().cameras[0].events[0].before.working,true);
 }finally{s.service.close();}
});
test('live HTTP API validates origin and manual actions; no database or demo routes exist',async()=>{
 const s=setup(),origin='http://127.0.0.1:8084',app=buildApp({logger:false,live:{service:s.service,origin}});
 try{
  const read=await app.inject({url:'/api/v1/live',headers:{host:'127.0.0.1:8084'}});assert.equal(read.statusCode,200);assert.equal(read.headers['cache-control'],'no-store');assert.equal(s.calls.length,0);
  assert.equal((await app.inject('/api/v1/ready')).json().storage,'memory');assert.equal((await app.inject('/api/v1/monitor/overview')).statusCode,404);
  for(const headers of [{host:'127.0.0.1:8084'},{host:'outside.invalid','x-digifort-live':'manual'},{host:'127.0.0.1:8084',origin:'https://outside.invalid','x-digifort-live':'manual'}]){
   assert.equal((await app.inject({method:'POST',url:'/api/v1/live/refresh',headers,payload:{}})).statusCode,403);
  }
  assert.equal((await app.inject({method:'POST',url:'/api/v1/live/refresh',headers:{host:'127.0.0.1:8084','x-digifort-live':'manual'},payload:{url:'https://other.invalid'}})).statusCode,400);
  assert.equal(s.calls.length,0);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/live/refresh',headers:{host:'127.0.0.1:8084','x-digifort-live':'manual'},payload:{}})).statusCode,200);
  assert.equal(s.calls.length,2);
 }finally{await app.close();}
});
test('overlapping refreshes do not duplicate remote requests',async()=>{
 let release!:()=>void,count=0;const wait=new Promise<void>(r=>{release=r;});
 const service=createLiveService({server,fetch:async input=>{count++;await wait;return new Response(body(String(input).includes('GetStatus')?states():inventory));}});
 try{const first=service.refresh();await new Promise(r=>setTimeout(r,0));await assert.rejects(service.refresh(),e=>e instanceof Error&&e.message==='IN_PROGRESS');assert.equal(count,2);release();await first;}
 finally{release();service.close();}
});
