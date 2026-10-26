import {readFileSync} from 'node:fs';
const base=process.env.MANAGEMENT_URL??'http://127.0.0.1:8085';
const access=JSON.parse(readFileSync(process.env.INTEGRATION_ACCESS_FILE,'utf8'));
const target=JSON.parse(readFileSync(process.env.INTEGRATION_SERVER_FILE,'utf8'));
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
await c('Page.navigate',{url:base+'/#/dashboard'});await wait("document.querySelector('input[type=password]')");
await evaluate(`(value=>{for(const [label,text]of [['Usuario',value.username],['Contraseña',value.password]]){const input=document.querySelector('[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));}})(${JSON.stringify(access)})`);
await evaluate("document.querySelector('form button').click()");await wait("document.querySelectorAll('nav a').length===3");
const cookies=await c('Network.getCookies',{urls:[base]});assert.ok(cookies.cookies.some(cookie=>cookie.name==='monitor_session'&&cookie.httpOnly));
assert.ok(await evaluate("!document.cookie.includes('monitor_session')"));
await evaluate("location.hash='/servers'");await wait("document.querySelector('h1')?.textContent==='Servidores Digifort'");
const temporaryName=target.name+' · validación';
async function fill(value){
 for(const [label,text]of [['Nombre del servidor',value.name],['Dirección del servidor',value.address],['Puerto del servidor',String(value.port)]]){
  await evaluate(`(value=>{const input=document.querySelector('[aria-label="'+value.label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value.text);input.dispatchEvent(new Event('input',{bubbles:true}));})(${JSON.stringify({label,text})})`);
 }
 await evaluate(`(value=>{const profile=document.querySelector('[aria-label="Perfil de credenciales"]');profile.value=value;profile.dispatchEvent(new Event('change',{bubbles:true}));})(${JSON.stringify(value.credentialRef)})`);
}
async function create(value){await evaluate("document.querySelector('.page-heading button').click()");await wait("document.querySelector('[aria-label=\"Perfil de credenciales\"]').options.length>0");await fill(value);await evaluate("document.querySelector('.server-form button').click()");await wait("!document.querySelector('.server-form')");}
const rowExpression=name=>`[...document.querySelectorAll('tbody tr')].find(r=>r.cells[0].textContent===${JSON.stringify(name)})`;
await create({...target,name:temporaryName});await wait(rowExpression(temporaryName));
await evaluate(rowExpression(temporaryName)+".querySelector('button').click()");await wait("document.querySelector('.server-form')");
const edited=temporaryName+' editado';await fill({...target,name:edited});await evaluate("document.querySelector('.server-form button').click()");await wait(rowExpression(edited));
await evaluate(rowExpression(edited)+".querySelectorAll('button')[1].click()");await wait(rowExpression(edited)+".cells[4].textContent==='Habilitado'");
await evaluate(rowExpression(edited)+".querySelectorAll('button')[1].click()");await wait(rowExpression(edited)+".cells[4].textContent==='Deshabilitado'");
assert.equal(queryPosts,0);
await evaluate("window.confirm=()=>true");await evaluate(rowExpression(edited)+".querySelectorAll('button')[2].click()");await wait('!('+rowExpression(edited)+')');
await evaluate("document.querySelector('.checkbox-label input').click()");await wait(rowExpression(edited)+".cells[4].textContent==='Baja lógica'");
await create(target);await wait(rowExpression(target.name));
await evaluate(rowExpression(target.name)+".querySelectorAll('button')[1].click()");await wait(rowExpression(target.name)+".cells[4].textContent==='Habilitado'");
await c('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(r=>setTimeout(r,200));
let dimensions=await evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})');assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
await evaluate(rowExpression(target.name)+".querySelector('button').click()");await wait("document.querySelector('.server-form')");
assert.equal(await evaluate("getComputedStyle(document.querySelector('.server-form-grid')).gridTemplateColumns.split(' ').length"),1);
await evaluate("[...document.querySelectorAll('.server-form button')].find(b=>b.textContent==='Cancelar').click()");
await c('Emulation.setDeviceMetricsOverride',{width:1512,height:1100,deviceScaleFactor:1,mobile:false});
await evaluate("location.hash='/dashboard'");await wait("document.querySelectorAll('.metric').length===5");
await evaluate("document.querySelector('.live-banner button').click()");await wait("!document.querySelector('.live-banner button').disabled");
const result=await evaluate("(async()=>{const d=await(await fetch('/api/v1/live')).json();return {total:d.summary.total,operational:d.summary.operational,down:d.summary.down,unknown:d.summary.unknown,health:d.server.health,collectorResults:d.server.endpoints.map(e=>({outcome:e.outcome,errorCode:e.errorCode}))};})()");
assert.equal(queryPosts,1);assert.deepEqual(errors,[]);
await evaluate("[...document.querySelectorAll('.topbar button')].find(b=>b.textContent==='Cerrar sesión').click()");await wait("document.querySelector('input[type=password]')");
assert.equal(await evaluate("(async()=>{const r=await fetch('/api/admin/servers');return r.status;})()"),401);
console.log(JSON.stringify({browser:'PASS',desktop:1512,mobile:390,checks:'login HttpOnly, current database role, create/read/update/enable/disable/logical retirement, mobile form, logout, one backend camera request',...result}));
await call('Target.closeTarget',{targetId});ws.close();
