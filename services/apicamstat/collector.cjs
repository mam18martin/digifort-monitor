'use strict';
const dns=require('node:dns/promises');const net=require('node:net');const http=require('node:http');const https=require('node:https');
const axios=require('axios');const {mapCameras}=require('./mapper.cjs');
function allowedNetworks(raw){const list=new net.BlockList();let count=0;
 for(const entry of String(raw||'').split(',').filter(Boolean)){const [address,prefix]=entry.trim().split('/');const family=net.isIP(address);if(!family)throw Error('INVALID_CIDR');list.addSubnet(address,Number(prefix??(family===4?32:128)),family===4?'ipv4':'ipv6');count++;}
 return {allows:ip=>list.check(ip,net.isIP(ip)===4?'ipv4':'ipv6'),configured:count>0};}
function createCollector({db,profiles,nodes=[],allowed,request}){
 async function collect(server){
  const started=Date.now();
  const safe={serverId:server.id,name:server.name,observedAt:new Date().toISOString(),outcome:'failed',errorCode:'READ_FAILED',durationMs:0};
  try{
   const credentials=profiles[server.credential_ref];if(!credentials||typeof credentials.username!=='string'||typeof credentials.password!=='string')throw Error('CREDENTIAL_PROFILE');
   const origin=new URL(server.endpoint_origin);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('CONFIGURATION');
   let get=request;
   if(!get){
    if(!allowed?.configured)throw Error('ALLOWLIST_REQUIRED');
    let dnsTimer;let addresses;try{addresses=await Promise.race([dns.lookup(origin.hostname.replace(/^\[|\]$/g,''),{all:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('DESTINATION_BLOCKED')),3000);})]);}finally{clearTimeout(dnsTimer);}
    if(!addresses.length||addresses.some(a=>!allowed.allows(a.address)))throw Error('DESTINATION_BLOCKED');
    const address=addresses[0];const lookup=(_host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}options?.all?callback(null,[address]):callback(null,address.address,address.family);};
    get=async endpoint=>{const agent=origin.protocol==='https:'?new https.Agent({lookup,rejectUnauthorized:true}):new http.Agent({lookup});try{
     const url=new URL('/Interface/Cameras/'+endpoint,origin);url.searchParams.set('ResponseFormat','JSON');url.searchParams.set('AuthUser',credentials.username);url.searchParams.set('AuthPass',credentials.password);
     return (await axios.get(url.toString(),{timeout:5000,maxContentLength:1048576,maxBodyLength:1048576,maxRedirects:0,proxy:false,httpAgent:agent,httpsAgent:agent,responseType:'json',transitional:{silentJSONParsing:false}})).data;
    }finally{agent.destroy();}};
   }
   const [inventory,status]=await Promise.all([get('GetCameras',server),get('GetStatus',server)]);
   const cameras=inventory?.Response?.Data?.Cameras,states=status?.Response?.Data?.Cameras;
   if(!Array.isArray(cameras)||!Array.isArray(states)||[...cameras,...states].some(c=>!c||typeof c.Name!=='string'||!c.Name))throw Error('INVALID_RESPONSE');
   for(const rows of [cameras,states])if(new Set(rows.map(c=>c.Name)).size!==rows.length)throw Error('DUPLICATE_NAME');
   const originIp=origin.hostname;const data=mapCameras(cameras,states,{ServerId:server.id,ServerName:server.name,ServerIp:originIp},nodes);
   return {meta:{...safe,outcome:'success',errorCode:null,rowCount:data.length,durationMs:Date.now()-started},data};
  }catch(error){const code=['CREDENTIAL_PROFILE','CONFIGURATION','ALLOWLIST_REQUIRED','DESTINATION_BLOCKED','INVALID_RESPONSE','DUPLICATE_NAME'].includes(error.message)?error.message:error.code==='ECONNABORTED'?'TIMEOUT':error.response?.status===401||error.response?.status===403?'AUTHENTICATION':'READ_FAILED';
   return {meta:{...safe,errorCode:code,durationMs:Date.now()-started},data:[]};}
 }
 return {async all(){
  const servers=(await db.query('SELECT id,name,endpoint_origin,credential_ref FROM digifort_servers WHERE enabled AND retired_at IS NULL ORDER BY id')).rows;
  if(servers.length>50)throw Error('SERVER_LIMIT');
  const results=[];for(let offset=0;offset<servers.length;offset+=4)results.push(...await Promise.all(servers.slice(offset,offset+4).map(collect)));
  return {data:results.flatMap(r=>r.data),servers:results.map(r=>r.meta)};
 }};
}
module.exports={createCollector,allowedNetworks};
