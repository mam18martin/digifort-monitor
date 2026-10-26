import {randomUUID} from 'node:crypto';
import type {MigrationConnection} from '../database/migrations.js';
export type IntegrationDb=Pick<MigrationConnection,'query'>;
export class ManagementError extends Error {constructor(public readonly code:string){super(code);}}
const projection='id,name,endpoint_origin,credential_ref,enabled,config_revision::text AS revision,retired_at,created_at';
export function serverRepository(db:IntegrationDb,profiles:string[]){
 const serialize=(r:Record<string,unknown>)=>{const url=new URL(String(r.endpoint_origin));return {id:r.id,name:r.name,address:url.hostname,protocol:url.protocol.slice(0,-1),port:Number(url.port||(url.protocol==='https:'?443:80)),credentialRef:r.credential_ref,enabled:r.enabled,revision:r.revision,retiredAt:r.retired_at,createdAt:r.created_at};};
 function validate(v:Record<string,unknown>){
  if(!v||typeof v!=='object'||Array.isArray(v))throw new ManagementError('INVALID_REQUEST');
  if(Object.keys(v).some(k=>!['name','address','protocol','port','credentialRef','enabled','revision'].includes(k)))throw new ManagementError('INVALID_REQUEST');
  const {name,address,protocol,port,credentialRef,enabled}=v;
  if(typeof name!=='string'||!name.trim()||name.length>120||typeof address!=='string'||address.length>253||!/^[A-Za-z0-9.:[\]-]+$/.test(address)
   ||!['http','https'].includes(String(protocol))||!Number.isInteger(port)||Number(port)<1||Number(port)>65535||typeof credentialRef!=='string'||!profiles.includes(credentialRef)||typeof enabled!=='boolean')throw new ManagementError('INVALID_REQUEST');
  let origin;try{const host=address.includes(':')&&!address.startsWith('[')?`[${address}]`:address;origin=new URL(`${protocol}://${host}:${port}`).origin;}catch{throw new ManagementError('INVALID_REQUEST');}
  return {name:name.trim(),origin,credentialRef,enabled};
 }
 return {
  async list(){return (await db.query(`SELECT ${projection} FROM digifort_servers ORDER BY retired_at NULLS FIRST,name,id`)).rows.map(serialize);},
  async create(input:Record<string,unknown>,operator:string){const v=validate(input),id=randomUUID();
   const r=await db.query(`WITH changed AS (INSERT INTO digifort_servers(id,config_key,name,endpoint_origin,credential_ref,enabled) VALUES ($1::uuid,$1::text,$2,$3,$4,$5) RETURNING *),
    audit AS (INSERT INTO server_admin_events(server_id,operator_id,action,config_revision) SELECT id,$6,'create',config_revision FROM changed)
    SELECT ${projection} FROM changed`,[id,v.name,v.origin,v.credentialRef,v.enabled,operator]);return serialize(r.rows[0]);
  },
  async update(id:string,input:Record<string,unknown>,operator:string){const v=validate(input);if(typeof input.revision!=='string'||!/^\d+$/.test(input.revision))throw new ManagementError('INVALID_REQUEST');
   const r=await db.query(`WITH changed AS (UPDATE digifort_servers SET name=$2,endpoint_origin=$3,credential_ref=$4,enabled=$5,config_revision=config_revision+1
    WHERE id=$1 AND config_revision=$6 AND retired_at IS NULL RETURNING *),
    audit AS (INSERT INTO server_admin_events(server_id,operator_id,action,config_revision) SELECT id,$7,'update',config_revision FROM changed)
    SELECT ${projection} FROM changed`,[id,v.name,v.origin,v.credentialRef,v.enabled,input.revision,operator]);
   if(!r.rows.length)throw new ManagementError('REVISION_CONFLICT');return serialize(r.rows[0]);
  },
  async retire(id:string,revision:string,operator:string){if(!/^\d+$/.test(revision))throw new ManagementError('INVALID_REQUEST');
   const r=await db.query(`WITH changed AS (UPDATE digifort_servers SET enabled=false,retired_at=clock_timestamp(),config_revision=config_revision+1 WHERE id=$1 AND config_revision=$2 AND retired_at IS NULL RETURNING *),
    audit AS (INSERT INTO server_admin_events(server_id,operator_id,action,config_revision) SELECT id,$3,'retire',config_revision FROM changed)
    SELECT ${projection} FROM changed`,[id,revision,operator]);if(!r.rows.length)throw new ManagementError('REVISION_CONFLICT');return serialize(r.rows[0]);
  },
 };
}
