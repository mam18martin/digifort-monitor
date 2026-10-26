// Test/review bootstrap only. It refuses all nonempty databases and every production name.
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from '../database/migrations.js';
import {hashPassword} from '../../../../packages/security/index.cjs';
try{
 if(process.env.INTEGRATION_DISPOSABLE!=='yes'||process.env.PGDATABASE!=='digifort_integration_isolated'||process.env.PGHOST!=='db')throw Error();
 const password=async(file:string)=>String(await readFile(file,'utf8')).trim();
 const client=new pg.Client({host:'db',database:'digifort_integration_isolated',user:'postgres',password:await password('/run/secrets/db_owner')});await client.connect();
 try{
  const tables=(await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public'")).rows[0].n;if(tables!==0)throw Error();
  await client.query('CREATE EXTENSION btree_gist');await migrate({exec:s=>client.query(s),query:(s,p)=>client.query(s,p)},'up');
  for(const [role,file] of [['monitor_manager','db_manager'],['apicamstat_reader','db_reader']]){
   const value=await password('/run/secrets/'+file);await client.query(`CREATE ROLE ${pg.escapeIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${pg.escapeLiteral(value)}`);
  }
  await client.query(`GRANT CONNECT ON DATABASE digifort_integration_isolated TO monitor_manager,apicamstat_reader;
   GRANT USAGE ON SCHEMA public TO monitor_manager,apicamstat_reader;
   GRANT SELECT,INSERT,UPDATE ON digifort_servers TO monitor_manager;
   GRANT SELECT,INSERT ON server_admin_events TO monitor_manager;
   GRANT SELECT(id,username,role,enabled,auth_version) ON app_users TO monitor_manager;
   GRANT SELECT ON digifort_servers,app_users TO apicamstat_reader;
   ALTER ROLE apicamstat_reader SET default_transaction_read_only=on;`);
  const account=JSON.parse(await readFile('/run/secrets/initial_admin','utf8'));
  await client.query("INSERT INTO app_users(username,password_hash,role) VALUES ($1,$2,'admin')",[account.username,await hashPassword(account.password)]);
  console.log('Base temporal vacía preparada; sin datos de cámaras ni servidores importados.');
 }finally{await client.end();}
}catch{console.error('Preparación temporal rechazada o incompleta; no se reutilizan bases existentes.');process.exitCode=1;}
