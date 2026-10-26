import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DigifortError } from '../src/digifort/errors.ts';
import { DigifortJsonClient } from '../src/digifort/json-client.ts';

const server={id:'synthetic-key',baseUrl:'https://digifort.invalid',username:'synthetic-user',password:'synthetic-secret'};
const body=(rows:unknown[])=>JSON.stringify({Response:{Data:{Cameras:rows}}});
const make=(fetch:typeof globalThis.fetch,timeoutMs=100)=>new DigifortJsonClient({server,fetch,timeoutMs});
const normal:typeof globalThis.fetch=async url=>new Response(body(String(url).includes('GetCameras')?
  [{Name:'1390F)',Description:'1390F)  Original ) description  ',Active:true}]:[{Name:'1390F)',Active:true,Working:false}]));

test('collection preserves exact Name/Description, municipal identity and explicit unknown completeness',async()=>{
  const result=await make(normal).collectEndpoints();
  const camera=result.snapshot!.cameras[0];
  assert.equal(camera.name,'1390F)');assert.equal(camera.inventory.Description,'1390F)  Original ) description  ');
  assert.equal(camera.municipalIdentity.cameraCode,'1390F');assert.equal(camera.working,false);
  for(const endpoint of result.endpoints){
    assert.equal(endpoint.attempts.length,1);const a=endpoint.attempts[0];
    assert.equal(a.responseReceived,true);assert.equal(a.responseValid,true);assert.equal(a.completeness,'unknown');
    assert.equal(a.httpStatus,200);assert.equal(a.rowCount,1);assert.ok(a.durationMs>=0);
    assert.ok(Date.parse(a.finishedAt)>=Date.parse(a.startedAt));
  }
});
for(const endpoint of ['GetCameras','GetStatus'] as const){
  test(`collection keeps ${endpoint} HTTP 401 separate and never returns a partial snapshot`,async()=>{
    const result=await make(async(url,init)=>String(url).includes(endpoint)?new Response('synthetic-secret',{status:401}):normal(url,init))
      .collectEndpoints({maxAttempts:3,retryDelayMs:0});
    assert.equal(result.snapshot,undefined);
    for(const item of result.endpoints){const a=item.attempts[0];
      assert.equal(a.outcome,item.endpoint===endpoint?'http_error':'success');
      assert.equal(item.attempts.length,1);
    }
    assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  });
}
test('collection retries only transient failed endpoints and retains every attempt',async()=>{
  let cameras=0,status=0;
  const result=await make(async(url,init)=>{
    if(String(url).includes('GetCameras')){cameras++;if(cameras===1)return new Response('private body',{status:503});}
    else status++;
    return normal(url,init);
  }).collectEndpoints({maxAttempts:3,retryDelayMs:0});
  assert.equal(cameras,2);assert.equal(status,1);assert.ok(result.snapshot);
  assert.deepEqual(result.endpoints[0].attempts.map(a=>a.outcome),['http_error','success']);
  assert.deepEqual(result.endpoints[0].attempts.map(a=>a.attemptNo),[1,2]);
});
test('collection distinguishes valid empty inventory, empty body, duplicates and invalid envelopes',async()=>{
  for(const [payload,outcome,code] of [[body([]),'success',undefined],['','invalid_response','INVALID_JSON'],
    [body([{Name:'x'},{Name:'x'}]),'invalid_response','DUPLICATE_NAME'],['{}','invalid_response','INVALID_RESPONSE']] as const){
    const result=await make(async()=>new Response(payload)).collectEndpoints({maxAttempts:3,retryDelayMs:0});
    for(const e of result.endpoints){assert.equal(e.attempts.length,1);assert.equal(e.attempts[0].outcome,outcome);
      assert.equal(e.attempts[0].errorCode,code);assert.equal(e.attempts[0].completeness,'unknown');}
  }
});
test('collection records a timeout before headers separately from a body timeout after HTTP 200',async()=>{
  const without=await make(async()=>new Promise<Response>(()=>{}),10).collectEndpoints();
  assert.equal(without.endpoints[0].attempts[0].errorCode,'TIMEOUT');
  assert.equal(without.endpoints[0].attempts[0].responseReceived,false);
  const withHeaders=await make(async()=>new Response(new ReadableStream<Uint8Array>({})),10).collectEndpoints();
  const a=withHeaders.endpoints[0].attempts[0];assert.equal(a.errorCode,'TIMEOUT');assert.equal(a.httpStatus,200);
  assert.equal(a.responseReceived,true);assert.equal(a.responseValid,false);
});
test('collection sanitizes thrown transport errors and bounds retries',async()=>{
  let calls=0;
  const result=await make(async()=>{calls++;throw new Error('https://user:synthetic-secret@private.invalid/raw');})
    .collectEndpoints({maxAttempts:3,retryDelayMs:0});
  assert.equal(calls,6);assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  assert.ok(result.endpoints.every(e=>e.attempts.every(a=>a.errorCode==='NETWORK_ERROR')));
});
test('collection rejects invalid retry settings before making requests',async()=>{
  await assert.rejects(make(async()=>{assert.fail('No transport expected');}).collectEndpoints({maxAttempts:4}),/CONFIGURATION/);
});

test('collection rejects forged error codes instead of returning untrusted strings',async()=>{
  const result=await make(async()=>{throw new DigifortError('synthetic-secret' as never);}).collectEndpoints();
  assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
  assert.ok(result.endpoints.every(e=>e.attempts[0].errorCode==='NETWORK_ERROR'));
});
