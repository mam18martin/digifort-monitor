'use strict';
// No legacy .env import, users, servers, credentials or node catalog are baked into this service.
const fs=require('node:fs');const pg=require('pg');const jwt=require('jsonwebtoken');
const {secret,createSecurity}=require('../../packages/security/index.cjs');
const {createCollector,allowedNetworks}=require('./collector.cjs');const {createApp}=require('./app.cjs');
async function main(){
 if(process.env.NODE_TLS_REJECT_UNAUTHORIZED==='0')throw Error();
 const pool=new pg.Pool({host:process.env.PGHOST,port:Number(process.env.PGPORT??5432),database:process.env.PGDATABASE,
  user:process.env.PGUSER,password:fs.readFileSync(process.env.PGPASSWORD_FILE,'utf8').trim(),connectionTimeoutMillis:5000,query_timeout:5000,options:'-c default_transaction_read_only=on'});
 pool.on('error',()=>{});
 const role=(await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(!role||Object.values(role).some(Boolean))throw Error('PRIVILEGED_DATABASE_ROLE');
 const profiles=JSON.parse(fs.readFileSync(process.env.DIGIFORT_PROFILES_FILE,'utf8'));
 const nodes=process.env.DIGIFORT_NODES_FILE?JSON.parse(fs.readFileSync(process.env.DIGIFORT_NODES_FILE,'utf8')):[];
 const collector=createCollector({db:pool,profiles,nodes,allowed:allowedNetworks(process.env.DIGIFORT_ALLOWED_CIDRS)});
 const app=await createApp({db:pool,collector,userTokens:createSecurity(jwt,secret('JWT_SECRET'),'monitor-users'),serviceTokens:createSecurity(jwt,secret('SERVICE_TOKEN_SECRET'),'apicamstat'),expiresIn:process.env.JWT_EXPIRES??'1h'});
 const server=app.listen(Number(process.env.PORT??3001),process.env.HOST??'0.0.0.0',()=>console.log('apicamstat iniciado.'));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>{void pool.end();}));
}
if(require.main===module)main().catch(()=>{console.error('No se pudo iniciar apicamstat; revisar configuración privada.');process.exitCode=1;});
module.exports={main};
