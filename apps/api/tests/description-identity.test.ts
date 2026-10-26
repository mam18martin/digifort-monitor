import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {descriptionIdentitySuite} from './description-identity-suite.ts';
test('Description identity source on isolated embedded PostgreSQL17',async t=>{
 const db=new PGlite({extensions:{btree_gist}});
 try{await db.exec('CREATE EXTENSION btree_gist');await descriptionIdentitySuite(t,db);}finally{await db.close();}
});
