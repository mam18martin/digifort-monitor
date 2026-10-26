import {test} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {descriptionIdentitySuite} from './description-identity-suite.ts';
test('Description source on explicitly isolated native PostgreSQL17',{skip:process.env.RUN_NATIVE_DB_TESTS!=='1'},async t=>{
 assert.equal(process.env.TEST_POSTGRES_DATABASE,'digifort_test_isolated');
 assert.equal(process.env.TEST_POSTGRES_HOST,'127.0.0.1');
 const client=new pg.Client({host:'127.0.0.1',port:Number(process.env.TEST_POSTGRES_PORT),database:'digifort_test_isolated',user:'postgres',password:'',ssl:false,connectionTimeoutMillis:5000});
 try{
  await client.connect();assert.match((await client.query('SHOW server_version')).rows[0].server_version,/^17\./);
  assert.equal((await client.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations'")).rows[0].n,0);
  await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
  await descriptionIdentitySuite(t,{query:(s,p)=>client.query(s,p),exec:s=>client.query(s)});
 }finally{await client.end();}
});
