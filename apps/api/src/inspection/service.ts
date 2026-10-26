import {validateServerConfig} from '../digifort/config.js';
import {requestText} from '../digifort/http.js';
import {parseMunicipalCameraName,type MunicipalNameCandidate} from '../digifort/municipal-code-parser.js';
import {DigifortError} from '../digifort/errors.js';
import type {DigifortServerConfig} from '../digifort/json-types.js';

export interface InspectionRow extends MunicipalNameCandidate {
  index:number;name:string|null;description:string|null;reason:string|null;
}
export interface InspectionSnapshot {
  observedAt:string;expiresAt:string;total:number;counts:Record<MunicipalNameCandidate['status'],number>;
  rows:InspectionRow[];completeness:'unknown';
}
export class InspectionError extends Error {
  constructor(public readonly code:string,public readonly httpStatus?:number){super(code);}
}
function reason(name:string|null,candidate:MunicipalNameCandidate):string|null{
  if(candidate.status==='valid')return null;
  if(candidate.status==='absent')return 'Name está ausente, vacío o sólo contiene espacios.';
  if(candidate.status==='unknown_type')return 'La letra de tipo no pertenece al catálogo D/F/P.';
  if(name&&/[\u0000-\u001f\u007f]/.test(name))return 'Name contiene caracteres de control.';
  if(!name||!/^[0-9]/.test(name))return 'Name no comienza con un código municipal; no se buscan números dentro del texto.';
  if(!/^[0-9]+[A-Z]/.test(name))return 'Los dígitos iniciales no están seguidos inmediatamente por una letra de tipo mayúscula.';
  return 'El sufijo no respeta la separación del código o contiene un delimitador repetido.';
}
/** Read-only, one target, one endpoint. No database, writer, status request or background collection. */
export function createInspectionService(options:{server:DigifortServerConfig;fetch?:typeof globalThis.fetch;now?:()=>number;ttlMs?:number}){
  const server=validateServerConfig(options.server),clock=options.now??Date.now;
  const ttlMs=options.ttlMs??30*60*1000;
  let snapshot:InspectionSnapshot|null=null,inFlight=false,expiry:ReturnType<typeof setTimeout>|undefined;
  function current(){if(snapshot&&Date.parse(snapshot.expiresAt)<=clock())snapshot=null;return {server:{id:'selected',label:'Servidor autorizado'},snapshot,inFlight};}
  return {
    current,
    close(){snapshot=null;clearTimeout(expiry);},
    async query(){
      if(inFlight)throw new InspectionError('IN_PROGRESS');
      inFlight=true;
      try{
        const url=new URL('/Interface/Cameras/GetCameras',server.baseUrl);
        url.searchParams.set('ResponseFormat','JSON');url.searchParams.set('AuthUser',server.username);url.searchParams.set('AuthPass',server.password);
        const text=await requestText(url,{fetch:options.fetch??globalThis.fetch,headers:new Headers({Accept:'application/json'}),
          timeoutMs:5000,maxResponseBytes:1048576,format:'JSON'});
        let body;try{body=JSON.parse(text);}catch{throw new InspectionError('INVALID_JSON');}
        const cameras=body?.Response?.Data?.Cameras;
        if(!Array.isArray(cameras))throw new InspectionError('INVALID_RESPONSE');
        const counts={valid:0,invalid:0,absent:0,unknown_type:0};
        const rows:InspectionRow[]=cameras.map((value,index)=>{
          if(!value||typeof value!=='object'||Array.isArray(value)
            ||(value.Name!=null&&typeof value.Name!=='string')||(value.Description!=null&&typeof value.Description!=='string'))throw new InspectionError('INVALID_RESPONSE');
          const name=value.Name??null,description=value.Description??null;
          const candidate=parseMunicipalCameraName(name);counts[candidate.status]++;
          return {index,name,description,...candidate,reason:reason(name,candidate)};
        });
        const observedAt=clock();
        snapshot={observedAt:new Date(observedAt).toISOString(),expiresAt:new Date(observedAt+ttlMs).toISOString(),total:rows.length,counts,rows,completeness:'unknown'};
        clearTimeout(expiry);expiry=setTimeout(()=>{snapshot=null;},ttlMs);expiry.unref();
        return {...current(),inFlight:false};
      }catch(error){
        if(error instanceof InspectionError)throw error;
        if(error instanceof DigifortError)throw new InspectionError(error.code,error.httpStatus);
        throw new InspectionError('READ_FAILED');
      }finally{inFlight=false;}
    },
  };
}
export type InspectionService=ReturnType<typeof createInspectionService>;
