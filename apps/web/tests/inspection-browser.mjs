const base=process.env.DEMO_URL??'http://127.0.0.1:8081';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw Error('Browser checks require a local demo');
import assert from 'node:assert/strict';
const meta=await (await fetch('http://127.0.0.1:9223/json/version')).json();
const ws=new WebSocket(meta.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
let count=0;const pending=new Map();const errors=[];let queryPosts=0;
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}else if(m.method==='Network.requestWillBeSent'&&m.params.request.method==='POST'&&m.params.request.url.endsWith('/api/v1/inspection/query'))queryPosts++;else if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text);};
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++count;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
const {targetId}=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
const c=(method,params={})=>call(method,params,sessionId);await c('Runtime.enable');await c('Page.enable');
const evaluate=async expression=>(await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
const wait=async expression=>{for(let i=0;i<100;i++){if(await evaluate('Boolean('+expression+')'))return;await new Promise(r=>setTimeout(r,100));}throw new Error('UI condition timed out: '+expression);};


await c('Network.enable');
await c('Emulation.setDeviceMetricsOverride',{width:1512,height:1100,deviceScaleFactor:1,mobile:false});
await c('Page.navigate',{url:base+'/#/inspection'});
await wait("document.querySelector('.inspection-query')&&!document.querySelector('.inspection-query').disabled");
assert.ok(await evaluate("document.querySelector('.page-heading').textContent.includes('La fuente oficial es Description')"));
const cached=await evaluate("Boolean(document.querySelector('.inspection-summary'))");
if(!cached&&process.env.INSPECTION_NO_QUERY==='1'){assert.equal(queryPosts,0);console.log('PASS: memory expired, manual renewal available; no remote query');await call('Target.closeTarget',{targetId});ws.close();process.exit(0);}
if(!cached)await evaluate("document.querySelector('.inspection-query').click()");
await wait("document.querySelector('.inspection-summary')&&document.querySelectorAll('.inspection-table tbody tr').length>0");
assert.equal(await evaluate("document.querySelector('h1').textContent"),'Inspección Digifort');
assert.ok(await evaluate("document.querySelector('.demo-banner').textContent.includes('LECTURA REAL')"));
assert.ok(await evaluate(`(async()=>{
 const data=await (await fetch('/api/v1/inspection',{cache:'no-store'})).json();
 return [...document.querySelectorAll('.inspection-table tbody tr')].every(tr=>{
  const r=data.snapshot.rows[Number(tr.dataset.inspectionIndex)];
  return (r.name===null||r.name===''||tr.cells[0].textContent===r.name)
   &&(r.description===null||r.description===''||tr.cells[1].textContent===r.description);
 })&&data.snapshot.total===data.snapshot.rows.length;
})()`));
// Use one real Name only within browser memory; never print names or take real-data screenshots.
await evaluate(`(async()=>{const d=await (await fetch('/api/v1/inspection')).json();
 const input=document.querySelector('[aria-label="Buscar por Name"]');
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,d.snapshot.rows.find(r=>r.name).name);
 input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await wait("document.querySelectorAll('.inspection-table tbody tr').length===1");
await evaluate(`(()=>{const input=document.querySelector('[aria-label="Buscar por Name"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Resultado del parser"]');el.value='valid';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait("document.querySelectorAll('.inspection-table tbody tr').length>0&&[...document.querySelectorAll('.inspection-table tbody tr')].every(r=>r.cells[4].textContent==='Válido')");
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Ordenar inspección"]');el.value='code';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await evaluate("document.querySelector('[aria-label=\"Cambiar dirección de orden\"]').click()");
await wait("document.querySelector('[aria-label=\"Cambiar dirección de orden\"]').textContent.includes('Descendente')");
assert.ok(await evaluate("(()=>{const values=[...document.querySelectorAll('.inspection-table tbody tr')].map(r=>r.cells[2].textContent);const order=new Intl.Collator('es',{numeric:true,sensitivity:'base'});return values.every((v,i)=>i===0||order.compare(values[i-1],v)>=0);})()"));
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Resultado del parser"]');el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));const size=document.querySelector('[aria-label="Filas de inspección"]');size.value='10000';size.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait("document.querySelectorAll('.inspection-table tbody tr').length>25");
const summary=await evaluate("(async()=>{const d=await (await fetch('/api/v1/inspection')).json();return {total:d.snapshot.total,counts:d.snapshot.counts};})()");
assert.equal(await evaluate("document.querySelectorAll('.inspection-table tbody tr').length"),summary.total);
const comparison=await evaluate("(()=>{const get=k=>Number(document.querySelector('[data-comparison-count=\"'+k+'\"]').textContent);return {name:get('name'),description:get('description'),different:get('different'),onlyDescription:get('only-description')};})()");
assert.equal(comparison.name,summary.counts.valid);
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Comparación de códigos"]');el.value='different';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait(`document.querySelectorAll('.inspection-table tbody tr').length===${comparison.different}`);
assert.ok(await evaluate("[...document.querySelectorAll('.inspection-table tbody tr')].every(r=>r.dataset.comparison==='different'&&r.cells[2].textContent!==r.cells[3].textContent&&r.cells[6].textContent.includes('≠'))"));
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Comparación de códigos"]');el.value='only_description';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait(`document.querySelectorAll('.inspection-table tbody tr').length===${comparison.onlyDescription}`);
assert.ok(await evaluate("[...document.querySelectorAll('.inspection-table tbody tr')].every(r=>r.dataset.comparison==='only_description')"));
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Comparación de códigos"]');el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));const status=document.querySelector('[aria-label="Resultado desde Description"]');status.value='valid';status.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait(`document.querySelectorAll('.inspection-table tbody tr').length===${comparison.description}`);
assert.ok(await evaluate("[...document.querySelectorAll('.inspection-table tbody tr')].every(r=>r.cells[5].textContent==='Válido')"));
await evaluate(`(()=>{const el=document.querySelector('[aria-label="Resultado desde Description"]');el.value='';el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await wait(`document.querySelectorAll('.inspection-table tbody tr').length===${summary.total}`);
await c('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(r=>setTimeout(r,300));
const dimensions=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
assert.ok(await evaluate("document.querySelector('.inspection-scroll').scrollWidth>document.querySelector('.inspection-scroll').clientWidth"));
assert.ok(await evaluate("Boolean(document.querySelector('.inspection-standalone'))"));
await evaluate("document.querySelector('.inspection-scroll').scrollLeft=1000");
assert.ok(await evaluate("document.querySelector('.inspection-scroll').scrollLeft>0"));
assert.equal(await evaluate("document.querySelectorAll('td script,td img').length"),0);
assert.equal(queryPosts,cached?0:1);assert.deepEqual(errors,[]);
console.log(JSON.stringify({browser:'PASS',desktop:1512,mobile:390,queryPosts,total:summary.total,counts:summary.counts,comparison,checks:'original text, search, filter, sort controls, all rows, no overflow, no runtime errors; no screenshots'}));
await call('Target.closeTarget',{targetId});ws.close();
