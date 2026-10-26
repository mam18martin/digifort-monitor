import {selectMigrationOwner,validOwnerRole} from '../database/migration-role.js';
// Explicit operator command only. Never runs on application startup.
import pg from 'pg';
import {hashPassword} from '../../../../packages/security/index.cjs';
try{
 if(!process.env.BOOTSTRAP_DATABASE_URL||!process.env.BOOTSTRAP_EXPECTED_DATABASE||!validOwnerRole(process.env.BOOTSTRAP_OWNER_ROLE))throw Error();
 let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw Error();}
 const value=JSON.parse(input);input='';
 if(typeof value.username!=='string'||!/^[A-Za-z0-9_.-]{3,80}$/.test(value.username))throw Error();
 const hash=await hashPassword(value.password);value.password='';
 const client=new pg.Client({connectionString:process.env.BOOTSTRAP_DATABASE_URL,connectionTimeoutMillis:5000});await client.connect();
 try{
  if((await client.query('SELECT current_database() name')).rows[0].name!==process.env.BOOTSTRAP_EXPECTED_DATABASE)throw Error();
  await selectMigrationOwner({exec:s=>client.query(s),query:(s,p)=>client.query(s,p)},process.env.BOOTSTRAP_OWNER_ROLE!);
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(731006)');
  if((await client.query("SELECT id FROM app_users WHERE role='admin'")).rows.length)throw Error();
  await client.query("INSERT INTO app_users(username,password_hash,role) VALUES ($1,$2,'admin')",[value.username,hash]);await client.query('COMMIT');console.log('Administrador inicial creado.');
 }catch{await client.query('ROLLBACK');throw Error();}finally{await client.end();}
}catch{console.error('No se creó el administrador. Revisar destino, política de contraseña o existencia de un administrador.');process.exitCode=1;}
