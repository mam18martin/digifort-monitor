export interface ApicamstatRow {CameraId:string;CameraType:string;Name:string;Description:string;Model:string;ServerName:string;ServerId:string;ServerIp?:string;StatusActive:boolean|null;StatusWorking:boolean|null;StatusCoverage:string;[key:string]:unknown;}
export interface ApicamstatResult {total:number;data:ApicamstatRow[];servers:{serverId:string;name:string;outcome:string;errorCode:string|null;observedAt:string;durationMs:number}[];}
export function apicamstatClient(options:{origin:string;serviceToken:()=>string;fetch?:typeof globalThis.fetch}){
 const url=new URL(options.origin);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('INVALID_APICAMSTAT_ORIGIN');
 const transport=options.fetch??globalThis.fetch;
 async function request(path:string,init:RequestInit){
  const response=await transport(new URL(path,url),{...init,redirect:'error',signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw Error(response.status===401?'INVALID_LOGIN':'APICAMSTAT_UNAVAILABLE');
  const reader=response.body?.getReader();if(!reader)throw Error('INVALID_RESPONSE');let bytes=0;const chunks:Uint8Array[]=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8*1024*1024){await reader.cancel();throw Error('RESPONSE_TOO_LARGE');}chunks.push(value);}}
  finally{reader.releaseLock();}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 }
 return {
  async login(username:string,password:string):Promise<{token:string;expiresIn:string}>{return request('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});},
  async cameras():Promise<ApicamstatResult>{const data=await request('/cameras',{method:'GET',headers:{Authorization:'Bearer '+options.serviceToken()}});
   if(!Array.isArray(data.data)||!Array.isArray(data.servers)
    ||data.data.some((r:ApicamstatRow)=>!r||['CameraId','Name','Description','ServerId','ServerName'].some(key=>typeof r[key]!=='string'))
    ||data.servers.some((s:{serverId:string;name:string;observedAt:string;outcome:string})=>!s||typeof s.serverId!=='string'||typeof s.name!=='string'||!Number.isFinite(Date.parse(s.observedAt))||!['success','failed'].includes(s.outcome)))throw Error('INVALID_RESPONSE');return data;},
 };
}
export type ApicamstatClient=ReturnType<typeof apicamstatClient>;
