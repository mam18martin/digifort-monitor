import type {EndpointAttempt} from '../digifort/collection-types.js';
export type LiveStatus='operational'|'down'|'inactive'|'unknown';
export type LiveFlags={active:boolean|null;working:boolean|null};
export interface LiveCamera extends LiveFlags {
 id:string;name:string;description:string|null;cameraCode:string|null;cameraNumber:string|null;cameraTypeCode:string|null;parserStatus:string;
 model:string|null;inventoryActive:boolean|null;inventoryObservedAt:string;statusObservedAt:string|null;
 coverage:'matched'|'missing';presentInLastInventory:boolean;events:{observedAt:string;before:LiveFlags;after:LiveFlags}[];
}
export interface LiveView {
 source:'real';storage:'memory';generatedAt:string;expiresAt:string|null;freshnessSeconds:number;inFlight:boolean;
 server:{id:string;name:string;health:string;lastAttemptAt:string|null;lastSuccessAt:string|null;lastResponseAt:string|null;endpoints:EndpointAttempt[];completeness:string};
 summary:{total:number;operational:number;down:number;inactive:number;unknown:number;serversWithProblems:number};
 cameras:(LiveCamera&{status:LiveStatus;quality:string})[];
}
