import {randomUUID} from 'node:crypto';
import {DigifortJsonClient} from '../digifort/json-client.js';
import {parseMunicipalDescription} from '../digifort/municipal-code-parser.js';
import type {DigifortServerConfig,DigifortInventory,DigifortStatus} from '../digifort/json-types.js';
import type {EndpointAttempt} from '../digifort/collection-types.js';

export const liveFreshnessMs=180000,liveRetentionMs=1800000;
import type {LiveCamera,LiveView} from './types.js';
export class LiveError extends Error {constructor(public readonly code:string){super(code);}}
/** Session-only state. No database, identity assignments, scheduler or remote calls on reads. */
export function createLiveService(options:{server:DigifortServerConfig;fetch?:typeof globalThis.fetch;now?:()=>number}){
 const clock=options.now??Date.now,client=new DigifortJsonClient({server:options.server,fetch:options.fetch,timeoutMs:5000,maxResponseBytes:1048576});
 const cameras=new Map<string,LiveCamera>();
 let inFlight=false,lastAttemptAt:string|null=null,lastSuccessAt:string|null=null,lastResponseAt:string|null=null;
 let endpoints:EndpointAttempt[]=[],expiry:ReturnType<typeof setTimeout>|undefined,expiresAt:string|null=null;
 function clear(){cameras.clear();expiresAt=null;}
 function current():LiveView{
  const now=clock();if(expiresAt&&Date.parse(expiresAt)<=now)clear();
  const successful=endpoints.length===2&&endpoints.every(e=>e.outcome==='success');
  const stale=lastSuccessAt!==null&&now-Date.parse(lastSuccessAt)>liveFreshnessMs;
  const health=!lastAttemptAt?'unknown':!successful?(endpoints.some(e=>e.responseReceived)?'degraded':'unreachable'):stale?'stale':'healthy';
  const items=[...cameras.values()].map<LiveView['cameras'][number]>(c=>{
   const fresh=c.statusObservedAt!==null&&now-Date.parse(c.statusObservedAt)<=liveFreshnessMs&&Date.parse(c.statusObservedAt)<=now
    &&now-Date.parse(c.inventoryObservedAt)<=liveFreshnessMs&&Date.parse(c.inventoryObservedAt)<=now;
   const quality=!successful?'server_problem':!fresh?'stale':!c.presentInLastInventory||c.coverage!=='matched'?'incomplete':c.active===null||c.working===null?'unknown_flags':'valid';
   const status=quality!=='valid'?'unknown':c.active===false?'inactive':c.working===false?'down':'operational';
   // Return detached rows: consumers cannot mutate retained state or fabricate history.
   return {...c,events:c.events.map(e=>({...e,before:{...e.before},after:{...e.after}})),status,quality};
  });
  const summary={total:items.length,operational:0,down:0,inactive:0,unknown:0,serversWithProblems:health==='healthy'?0:1};
  for(const item of items)summary[item.status as 'operational'|'down'|'inactive'|'unknown']++;
  return {source:'real' as const,storage:'memory' as const,generatedAt:new Date(now).toISOString(),expiresAt,freshnessSeconds:180,inFlight,
   server:{id:'selected',name:'Servidor Digifort',health,lastAttemptAt,lastSuccessAt,lastResponseAt,endpoints:endpoints.map(e=>({...e})),completeness:'unknown'},summary,cameras:items};
 }
 function inventory(rows:DigifortInventory[],at:string){
  if(rows.length+cameras.size>20000)throw new LiveError('INVENTORY_LIMIT');
  for(const c of cameras.values())c.presentInLastInventory=false;
  for(const row of rows){
   const candidate=parseMunicipalDescription(row.Description),old=cameras.get(row.Name);
   cameras.set(row.Name,{...(old??{id:randomUUID(),active:null,working:null,statusObservedAt:null,coverage:'missing',events:[]}),
    name:row.Name,description:row.Description,cameraCode:candidate.cameraCode,cameraNumber:candidate.cameraNumber,cameraTypeCode:candidate.cameraTypeCode,
    parserStatus:candidate.status,model:row.Model,inventoryActive:row.Active,inventoryObservedAt:at,presentInLastInventory:true});
  }
 }
 function status(rows:DigifortStatus[],at:string){
  for(const c of cameras.values())c.coverage='missing';
  for(const row of rows){
   const c=cameras.get(row.Name);if(!c)continue;
   if(c.statusObservedAt!==null&&(c.active!==row.Active||c.working!==row.Working)){
    c.events.push({observedAt:at,before:{active:c.active,working:c.working},after:{active:row.Active,working:row.Working}});
    if(c.events.length>50)c.events.shift();
   }
   c.active=row.Active;c.working=row.Working;c.statusObservedAt=at;c.coverage='matched';
  }
 }
 return {
  current,close(){clearTimeout(expiry);clear();},
  async refresh(){
   if(inFlight)throw new LiveError('IN_PROGRESS');
   inFlight=true;lastAttemptAt=new Date(clock()).toISOString();
   try{
    const result=await client.collectEndpoints({maxAttempts:1,retryDelayMs:0});
    endpoints=result.endpoints.map(e=>e.attempts[0]);
    const at=new Date(clock()).toISOString();
    if(endpoints.some(e=>e.responseReceived))lastResponseAt=at;
    if(result.inventory){inventory(result.inventory,at);expiresAt=new Date(clock()+liveRetentionMs).toISOString();clearTimeout(expiry);expiry=setTimeout(clear,liveRetentionMs);expiry.unref();}
    if(result.statuses)status(result.statuses,at);
    if(endpoints.every(e=>e.outcome==='success'))lastSuccessAt=at;
    return {...current(),inFlight:false};
   }catch(error){
    endpoints=endpoints.map(e=>({...e,outcome:'invalid_response',errorCode:'INVALID_RESPONSE',responseValid:false}));
    throw error;
   }finally{inFlight=false;}
  },
 };
}
export type LiveService=ReturnType<typeof createLiveService>;
