export type CameraStatus='operational'|'down'|'unknown'|'inactive';
export interface Camera {id:string;cameraCode:string|null;name:string|null;description:string|null;serverId:string|null;serverName:string|null;
  active:boolean|null;working:boolean|null;activeSource:string;observedAt:string|null;ageSeconds:number|null;status:CameraStatus;quality:string;coverage:string;}
export interface Server {id:string;name:string;health:string;transport:string;query:string;cameraCount:number;lastAttemptAt:string|null;lastSuccessAt:string|null;lastResponseAt:string|null;consecutiveFailures:number;}
export interface Overview {total:number;operational:number;down:number;unknown:number;inactive:number;serversWithProblems:number;servers:Server[];generatedAt:string;freshnessSeconds:number;demo:boolean;}
export interface CameraPage {items:Camera[];total:number;page:number;pageSize:number;}
export interface CameraEvent {id:string;observedAt:string;active:boolean|null;working:boolean|null;reason:string;coverage:string;serverName:string;}
export interface CameraDetail extends Camera {events:CameraEvent[];freshnessSeconds:number;}
export async function request<T>(path:string,signal?:AbortSignal):Promise<T>{
  const response=await fetch('/api/v1/monitor/'+path,{signal});
  if(!response.ok)throw new Error(response.status===404?'No se encontró la cámara.':'No se pudo conectar con el monitoreo. Intentá actualizar la vista.');
  return response.json();
}
export interface IdentityIncident {id:string;proposalId:string|null;kind:string;state:string;source:string;cameraId:string;name:string|null;serverId:string|null;serverName:string|null;
 candidateCode:string|null;confirmedCode:string|null;currentConfirmedCode:string|null;relatedCameraId:string|null;relatedName:string|null;relatedCandidateCode:string|null;
 detectedAt:string;inventoryId:string|null;serverRunId:string|null;stateSource:string;revision:string|null;evidenceCount:number;codeSource?:'Name'|'Description';}
export interface IdentityPage {items:IdentityIncident[];total:number;page:number;pageSize:number;readOnly:true;}
export interface IdentityDetail extends IdentityIncident {evidence:{id:string;serverRunId:string;inventoryId:string;recordedAt:string;code:string}[];
 decisions:{action:string;reasonCode:string;operatorId:string;decidedAt:string;revision:string}[];applicationBlocked:true;}
