import {readFile} from 'node:fs/promises';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import {createSecurity,secret} from '../../../../packages/security/index.cjs';
import {apicamstatClient} from './client.js';
import {buildApp} from '../app.js';
try{
 const origin=process.env.APP_ORIGIN;if(!origin||!['127.0.0.1','localhost'].includes(new URL(origin).hostname))throw Error();
 const profiles=JSON.parse(await readFile(process.env.DIGIFORT_PROFILES_FILE!,'utf8'));
 const userTokens=createSecurity(jwt,secret('JWT_SECRET'),'monitor-users');
 const serviceTokens=createSecurity(jwt,secret('SERVICE_TOKEN_SECRET'),'apicamstat');
 if(!process.env.PGHOST||!process.env.PGDATABASE||!process.env.PGUSER||!process.env.APICAMSTAT_ORIGIN)throw Error();
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT??5432),database:process.env.PGDATABASE,user:process.env.PGUSER,
  password:(await readFile(process.env.PGPASSWORD_FILE!,'utf8')).trim(),connectionTimeoutMillis:5000,query_timeout:5000});
 pool.on('error',()=>{});
 const role=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(!role||Object.values(role).some(Boolean))throw Error();
 const client=apicamstatClient({origin:process.env.APICAMSTAT_ORIGIN,serviceToken:()=>serviceTokens.sign({sub:'digifort-monitor',scope:'cameras:read'},'5m')});
 const app=buildApp({logger:false,checkDatabase:async()=>{if(!(await pool.query("SELECT id FROM schema_migrations WHERE id='005_apicamstat_management'")).rows.length)throw Error();},
  integration:{db:pool,client,tokens:userTokens,origin,profiles:Object.keys(profiles),temporary:process.env.PGDATABASE==='digifort_integration_isolated'}});
 app.addHook('onClose',async()=>{await pool.end();});
 for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close();});
 await app.listen({host:process.env.HOST??'127.0.0.1',port:Number(process.env.PORT??3000)});
 console.log('Backend de administración iniciado.');
}catch{console.error('No se pudo iniciar la integración; revisar configuración y migración 005.');process.exitCode=1;}
