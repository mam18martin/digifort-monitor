import {randomUUID} from 'node:crypto';
import type {ApicamstatClient,ApicamstatRow} from './client.js';
import type {LiveCamera,LiveView} from '../live/types.js';
/** This adapter never contacts Digifort or parses a municipal code. CameraId belongs to apicamstat. */
export function integrationCameraService(client:ApicamstatClient){
 const cameras=new Map<string,LiveCamera&{serverId:string}>();let busy=false,lastAttempt:string|null=null,lastSuccess:string|null=null,lastResponse:string|null=null;
 let servers:{serverId:string;name:string;outcome:string;observedAt:string;errorCode:string|null}[]=[],expiresAt:string|null=null,timer:ReturnType<typeof setTimeout>|undefined;
 const flags=(row:ApicamstatRow)=>({active:typeof row.StatusActive==='boolean'?row.StatusActive:null,working:typeof row.StatusWorking==='boolean'?row.StatusWorking:null});
 function current():LiveView{
  const now=Date.now();if(expiresAt&&Date.parse(expiresAt)<=now){cameras.clear();expiresAt=null;}
  const healthy=servers.length>0&&servers.every(s=>s.outcome==='success');
  const stale=lastSuccess!==null&&now-Date.parse(lastSuccess)>180000;
  const health=!lastAttempt||servers.length===0?'unknown':!healthy?'degraded':stale?'stale':'healthy';
  const items=[...cameras.values()].map<LiveView['cameras'][number]>(c=>{
   const server=servers.find(s=>s.serverId===c.serverId);const valid=server?.outcome==='success'&&c.presentInLastInventory&&c.coverage==='matched'&&c.statusObservedAt!==null
    &&Date.parse(c.statusObservedAt)<=now&&Date.parse(c.inventoryObservedAt)<=now&&now-Date.parse(c.inventoryObservedAt)<=180000&&now-Date.parse(c.statusObservedAt)<=180000&&c.active!==null&&c.working!==null;
   return {...c,events:c.events.map(e=>({...e,before:{...e.before},after:{...e.after}})),status:!valid?'unknown':c.active===false?'inactive':c.working===false?'down':'operational',quality:valid?'valid':'server_problem'};
  });
  const summary={total:items.length,operational:0,down:0,inactive:0,unknown:0,serversWithProblems:servers.filter(s=>s.outcome!=='success').length+(stale?servers.filter(s=>s.outcome==='success').length:0)};
  for(const c of items)summary[c.status]++;
  return {source:'real',storage:'memory',generatedAt:new Date(now).toISOString(),expiresAt,freshnessSeconds:180,inFlight:busy,
   server:{id:'configured',name:'Servidores administrados',health,lastAttemptAt:lastAttempt,lastSuccessAt:lastSuccess,lastResponseAt:lastResponse,completeness:'unknown',endpoints:servers.map(s=>({endpoint:'GetCameras',attemptNo:1,startedAt:s.observedAt,finishedAt:s.observedAt,durationMs:0,responseReceived:s.outcome==='success',responseValid:s.outcome==='success',outcome:s.outcome==='success'?'success':'transport_error',completeness:'unknown',errorCode:s.errorCode?'NETWORK_ERROR':undefined}))},summary,cameras:items};
 }
 return {current,close(){clearTimeout(timer);cameras.clear();},async refresh(){
  if(busy)throw Error('IN_PROGRESS');busy=true;lastAttempt=new Date().toISOString();
  try{const result=await client.cameras();lastResponse=new Date().toISOString();servers=result.servers;
   for(const c of cameras.values())c.presentInLastInventory=false;
   for(const row of result.data){
    const server=servers.find(s=>s.serverId===row.ServerId);if(!server||server.outcome!=='success')continue;
    const key=JSON.stringify([server.serverId,row.Name]),previous=cameras.get(key),f=row.StatusCoverage==='matched'?flags(row):{active:previous?.active??null,working:previous?.working??null},at=server.observedAt;
    const events=previous?.events??[];
    if(previous?.statusObservedAt&&row.StatusCoverage==='matched'&&(previous.active!==f.active||previous.working!==f.working))events.push({observedAt:at,before:{active:previous.active,working:previous.working},after:f});
    cameras.set(key,{id:previous?.id??randomUUID(),serverId:server.serverId,name:row.Name,description:row.Description,
     cameraCode:row.CameraId||null,cameraNumber:row.CameraId||null,cameraTypeCode:row.CameraType||null,parserStatus:'apicamstat',
     model:typeof row.Model==='string'?row.Model:null,inventoryActive:null,...f,inventoryObservedAt:at,statusObservedAt:row.StatusCoverage==='matched'?at:previous?.statusObservedAt??null,
     coverage:row.StatusCoverage==='matched'?'matched':'missing',presentInLastInventory:true,events:events.slice(-50)});
   }
   if(servers.length&&servers.every(s=>s.outcome==='success'))lastSuccess=new Date().toISOString();
   if(result.data.length){expiresAt=new Date(Date.now()+1800000).toISOString();clearTimeout(timer);timer=setTimeout(()=>cameras.clear(),1800000);timer.unref();}
   return {...current(),inFlight:false};
  }catch{servers=servers.map(s=>({...s,outcome:'failed',errorCode:'APICAMSTAT_UNAVAILABLE'}));throw Error('APICAMSTAT_UNAVAILABLE');}
  finally{busy=false;}
 }};
}
