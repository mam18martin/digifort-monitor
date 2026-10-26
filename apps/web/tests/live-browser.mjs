const base=process.env.LIVE_URL??'http://127.0.0.1:8084';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Browser checks require a local demo');
import assert from 'node:assert/strict';
const meta=await (await fetch('http://127.0.0.1:9223/json/version')).json();
const ws=new WebSocket(meta.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let count=0;const pending=new Map();const errors=[];let queryPosts=0;
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Network.requestWillBeSent'&&m.params.request.method==='POST'&&m.params.request.url.endsWith('/api/v1/live/refresh'))queryPosts++;else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++count;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
const {targetId}=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
const c=(method,params={})=>call(method,params,sessionId);await c('Runtime.enable');await c('Page.enable');
const evaluate=async expression=>(await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timed out: '+expression);};


await c('Network.enable');

await c('Emulation.setDeviceMetricsOverride',{width:1512,height:1100,deviceScaleFactor:1,mobile:false});
await c('Page.navigate',{url:base+'/#/dashboard'});
await wait("document.querySelector('.live-refresh')&&!document.querySelector('.live-refresh').disabled");
const initial=await evaluate("(async()=>{const d=await(await fetch('/api/v1/live',{cache:'no-store'})).json();return {hasAttempt:Boolean(d.server.lastAttemptAt),total:d.summary.total};})()");
if(!initial.hasAttempt){
 if(process.env.LIVE_NO_QUERY==='1'){assert.equal(queryPosts,0);console.log('PASS: live app ready, no remote refresh requested');await call('Target.closeTarget',{targetId});ws.close();process.exit(0);}
 await evaluate("document.querySelector('.live-refresh').click()");
}
await wait("document.querySelectorAll('tbody tr').length>0&&!document.querySelector('.live-refresh').disabled");
const summary=await evaluate("(async()=>{const d=await(await fetch('/api/v1/live',{cache:'no-store'})).json();return {summary:d.summary,source:d.source,storage:d.storage,health:d.server.health,endpoints:d.server.endpoints.map(e=>({endpoint:e.endpoint,outcome:e.outcome,httpStatus:e.httpStatus,errorCode:e.errorCode,rowCount:e.rowCount,attemptNo:e.attemptNo})),emptyInitialHistory:d.cameras.every(c=>c.events.length===0)};})()");
assert.equal(summary.source,'real');assert.equal(summary.storage,'memory');assert.ok(summary.summary.total>0);
assert.equal(summary.summary.total,summary.summary.operational+summary.summary.down+summary.summary.inactive+summary.summary.unknown);
assert.equal(summary.endpoints.length,2);assert.ok(summary.endpoints.every(e=>e.attemptNo===1));
assert.equal(await evaluate("document.querySelectorAll('nav a').length"),3);
assert.ok(await evaluate("!document.body.textContent.includes('DEMOSTRACIÓN')&&!document.body.textContent.includes('DEMO LOCAL')"));
assert.equal(await evaluate("document.querySelectorAll('.metric').length"),5);
await evaluate("document.querySelector('.camera-link').click()");await wait("document.querySelector('.live-history')");
if(summary.emptyInitialHistory)assert.ok(await evaluate("document.querySelector('.live-history').textContent.includes('No hay transiciones reales registradas')"));
assert.ok(await evaluate("document.body.textContent.includes('GetStatus')&&document.body.textContent.includes('Description original')"));
await evaluate("location.hash='/cameras'");await wait("document.querySelector('[aria-label=\"Buscar cámaras reales\"]')&&document.querySelectorAll('tbody tr').length>0");
const searchedCount=await evaluate(`(async()=>{const d=await(await fetch('/api/v1/live')).json();const needle=d.cameras[0].name;const input=document.querySelector('[aria-label="Buscar cámaras reales"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,needle);input.dispatchEvent(new Event('input',{bubbles:true}));return Math.min(25,d.cameras.filter(c=>[c.name,c.description,c.cameraCode].some(v=>v?.toLocaleLowerCase('es').includes(needle.toLocaleLowerCase('es')))).length);})()`);
await wait(`document.querySelectorAll('tbody tr').length===${searchedCount}`);
await evaluate(`(()=>{const input=document.querySelector('[aria-label="Buscar cámaras reales"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));const select=document.querySelector('[aria-label="Estado de cámaras reales"]');select.value='unknown';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait("[...document.querySelectorAll('tbody tr')].every(r=>r.cells[2].textContent==='Desconocido')");
await evaluate("location.hash='/servers'");await wait("document.querySelectorAll('.live-endpoints article').length===2");
assert.ok(await evaluate("document.body.textContent.includes('GetCameras')&&document.body.textContent.includes('GetStatus')"));
await c('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await evaluate("location.hash='/dashboard'");await wait("document.querySelectorAll('.metric').length===5");
let dimensions=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
assert.equal(await evaluate("getComputedStyle(document.querySelector('nav')).gridTemplateColumns.split(' ').length"),3);
await evaluate("location.hash='/cameras'");await wait("document.querySelectorAll('tbody tr').length>0");
dimensions=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
if(process.env.LIVE_TEST_FAILURE==='1'){
 await evaluate(`(()=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>String(input).endsWith('/api/v1/live/refresh')?Promise.reject(new Error('synthetic frontend failure')):original(input,init);location.hash='/dashboard';})()`);
 await wait("document.querySelectorAll('.metric').length===5");
 await evaluate("document.querySelector('.live-refresh').click()");
 await wait("document.querySelector('[role=alert]')&&!document.querySelector('.live-refresh').disabled");
 assert.ok(await evaluate("[...document.querySelectorAll('tbody tr')].every(r=>r.cells[2].textContent==='Desconocido')"));
}
assert.equal(queryPosts,initial.hasAttempt?0:1);assert.deepEqual(errors,[]);
console.log(JSON.stringify({browser:'PASS',desktop:1512,mobile:390,refreshPosts:queryPosts,...summary,checks:'dashboard, real list, search, state filter, detail, empty history, server communication, no demo navigation, no overflow or runtime errors; no screenshots'}));
await call('Target.closeTarget',{targetId});ws.close();
