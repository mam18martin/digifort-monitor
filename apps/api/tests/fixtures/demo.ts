import { detectIdentityProposalsInTransaction,readObservation,recordProposal } from '../../src/identity/detection.js';
import type { MigrationConnection } from '../../src/database/migrations.js';
export const demoDatabase='digifort_demo_isolated';
export const fixtureId=(n:number)=>`d3400000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
export const demoMarker=fixtureId(9000);
const places=['Plaza del Encuentro','Paseo del Arroyo','Centro Cultural','Parque de los Olmos','Avenida del Sol','Terminal del Oeste','Polideportivo','Puente del Molino','Biblioteca Central','Mercado del Barrio','Costanera Sur','Acceso al Parque'];
const serverDefinitions=[{name:'Nodo Centro',count:24},{name:'Nodo Oeste',count:12},{name:'Nodo Este',count:8},{name:'Nodo Sur',count:4}];

/** Only synthetic first assignments. Caller must supply an empty, isolated demo schema. */
export async function seedDemoData(db:MigrationConnection,now=new Date()):Promise<void>{
  const populated=(await db.query('SELECT (SELECT count(*) FROM cameras)+(SELECT count(*) FROM digifort_servers) AS n')).rows[0];
  if(Number(populated.n)!==0)throw new Error('Demo seed requires empty inventory');
  await db.exec('BEGIN');
  try{
    let index=0;
    for(const [serverIndex,definition] of serverDefinitions.entries()){
      const serverId=fixtureId(100+serverIndex),token=fixtureId(200+serverIndex);
      await db.query(`INSERT INTO digifort_servers(id,config_key,name,endpoint_origin,enabled)
        VALUES ($1,$2,$3,'https://digifort.invalid',false)`,[serverId,`demo-${serverIndex}`,definition.name]);
      await db.query(`INSERT INTO server_sync_control(server_id,issued_sequence,applied_sequence,lease_token,lease_until)
        VALUES ($1,1,1,$2,clock_timestamp()+interval '1 hour')`,[serverId,token]);
      const cameras=Array.from({length:definition.count},(_,local)=>{
        const number=index++;const provisional=number===7||number===29||number===42;
        return {id:fixtureId(1000+number),bindingId:fixtureId(2000+number),number,local,provisional,
          code:String(1390+number)+(number%5===0?'D':number%7===0?'P':'F'),mode:local%12};
      });
      const previous=new Map<string,{active:boolean|null;working:boolean|null;eventId:string;sequence:number}>();
      let healthSequence=0;
      for(let frame=0;frame<3;frame++){
        const at=new Date(now.getTime()-[7200000,1800000,20000][frame]).toISOString();
        const runId=fixtureId(3000+serverIndex*10+frame),globalId=fixtureId(4000+serverIndex*10+frame);
        const seen=cameras.filter(c=>!(frame===2&&c.mode===3&&serverIndex<2));
        if(frame>0)await db.query('UPDATE server_sync_control SET issued_sequence=$2,applied_sequence=$2 WHERE server_id=$1',[serverId,frame+1]);
        await db.query(`INSERT INTO sync_runs(id,request_key,trigger,started_at,finished_at,outcome)
          VALUES ($1,$2,'manual',$3,$3,'partial')`,[globalId,serverIndex===0&&frame===0?demoMarker:globalId,at]);
        await db.query(`INSERT INTO sync_server_runs(id,run_id,server_id,sequence,config_revision,lease_token,started_at,finished_at,outcome,applied_at,
          inventory_completeness,inventory_count,status_count,matched_count,missing_status_count,orphan_status_count)
          VALUES ($1,$2,$3,$4,1,$5,$6,$6,'partial',$6,'unknown',$7,$7,$7,0,0)`,[runId,globalId,serverId,frame+1,token,at,seen.length]);
        for(const camera of seen){
          const name=camera.number===28?'1390D)':camera.number===30?'9090F)':camera.provisional?`DEMO-PROVISIONAL-${camera.number+1}`:camera.code+')';
          if(frame===0){
            await db.query(`INSERT INTO cameras(id,camera_number,camera_type_code,identity_review,created_at)
              VALUES ($1,$2,$3,$4,$5)`,[camera.id,camera.provisional?null:camera.code.slice(0,-1),camera.provisional?null:camera.code.slice(-1),camera.provisional?'provisional':'confirmed',at]);
            await db.query(`INSERT INTO camera_bindings(id,camera_id,server_id,external_name,valid_from) VALUES ($1,$2,$3,$4,$5)`,[camera.bindingId,camera.id,serverId,name,at]);
            const description=(camera.provisional?'':name+' ')+(camera.number===7?'Referencia descriptiva 9999F) · ': '')+places[camera.number%places.length]+` · ${['acceso principal','sector norte','cruce peatonal','sector sur'][camera.number%4]}`;
            await db.query(`INSERT INTO camera_inventory_versions(camera_id,binding_id,valid_from,first_observed_at,last_confirmed_at,description_original,description_text,
              code_candidate,number_candidate,type_code_candidate,code_parse_status,code_review_status,code_parser_version,source_server_run_id)
              VALUES ($1,$2,$3,$3,$3,$4,$4,$5,$6,$7,$8,$9,'description-v1',$10)`,[camera.id,camera.bindingId,at,description,
              camera.provisional?null:name.slice(0,-1),camera.provisional?null:name.slice(0,-2),camera.provisional?null:name.slice(-2,-1),
              camera.provisional?'invalid':'valid',camera.provisional?'pending':'accepted',runId]);
          }else await db.query('UPDATE camera_inventory_versions SET last_confirmed_at=$2 WHERE camera_id=$1 AND valid_to IS NULL',[camera.id,at]);
          const active=frame===0?true:camera.mode===2&&serverIndex<2?false:true;
          const working=frame===0?true:camera.mode===1&&serverIndex<2?null:frame===1?false:camera.mode===0&&serverIndex<2?false:true;
          const old=previous.get(camera.id);let eventId=old?.eventId;
          if(!old||old.active!==active||old.working!==working){
            eventId=fixtureId(5000+serverIndex*1000+camera.local*10+frame);
            await db.query(`INSERT INTO camera_state_changes(id,camera_id,binding_id,server_id,server_run_id,state_sequence,observation_epoch,observed_at,last_confirmed_at,
              status_active,working,status_coverage,reason,normalization_version)
              VALUES ($1,$2,$3,$4,$5,$6,1,$7,$7,$8,$9,'matched',$10,1)`,[eventId,camera.id,camera.bindingId,serverId,runId,(old?.sequence??0)+1,at,active,working,old?'state_changed':'initial']);
            previous.set(camera.id,{active,working,eventId,sequence:(old?.sequence??0)+1});
          }
          await db.query(`UPDATE camera_current_state SET binding_id=$2,inventory_active=$3,status_active=$3,working=$4,status_coverage='matched',inventory_presence='present',
            last_snapshot_success_at=$5,last_attempt_at=$5,last_inventory_seen_at=$5,last_status_seen_at=$5,active_observed_at=$5,
            working_observed_at=$6,observation_epoch=1,applied_sequence=$7,last_state_change_id=$8 WHERE camera_id=$1`,
          [camera.id,camera.bindingId,active,working,at,working===null?null:at,frame+1,eventId]);
        }
        healthSequence++;
        const healthId=fixtureId(10000+serverIndex*10+frame);
        await db.query(`INSERT INTO server_health_changes(id,server_id,server_run_id,health_sequence,observed_at,last_confirmed_at,transport_state,query_state)
          VALUES ($1,$2,$3,$4,$5,$5,'responding',$6)`,[healthId,serverId,runId,healthSequence,at,frame===1?'partial':'healthy']);
        await db.query(`INSERT INTO server_current_health(server_id,health_change_id,health_sequence,last_attempt_at,last_response_at,last_success_at,consecutive_failures)
          VALUES ($1,$2,$3,$4,$4,$4,0) ON CONFLICT(server_id) DO UPDATE SET health_change_id=excluded.health_change_id,health_sequence=excluded.health_sequence,
          last_attempt_at=excluded.last_attempt_at,last_response_at=excluded.last_response_at,last_success_at=excluded.last_success_at`,[serverId,healthId,healthSequence,at]);
      }
      if(serverIndex>=2){
        const at=new Date(now.getTime()-5000).toISOString(),runId=fixtureId(3000+serverIndex*10+3),globalId=fixtureId(4000+serverIndex*10+3);
        await db.query('UPDATE server_sync_control SET issued_sequence=4 WHERE server_id=$1',[serverId]);
        await db.query(`INSERT INTO sync_runs(id,request_key,trigger,started_at,finished_at,outcome) VALUES ($1,$1,'manual',$2,$2,'failed')`,[globalId,at]);
        await db.query(`INSERT INTO sync_server_runs(id,run_id,server_id,sequence,config_revision,lease_token,started_at,finished_at,outcome)
          VALUES ($1,$2,$3,4,1,$4,$5,$5,'failed')`,[runId,globalId,serverId,token,at]);
        const healthId=fixtureId(10000+serverIndex*10+3);
        await db.query(`INSERT INTO server_health_changes(id,server_id,server_run_id,health_sequence,observed_at,last_confirmed_at,transport_state,query_state)
          VALUES ($1,$2,$3,4,$4,$4,$5,$6)`,[healthId,serverId,runId,at,serverIndex===2?'responding':'unreachable',serverIndex===2?'auth_error':'transport_error']);
        await db.query(`UPDATE server_current_health SET health_change_id=$2,health_sequence=4,last_attempt_at=$3,consecutive_failures=1,
          last_response_at=CASE WHEN $4 THEN $3::timestamptz ELSE last_response_at END WHERE server_id=$1`,[serverId,healthId,at,serverIndex===2]);
      }
      await db.query('UPDATE server_sync_control SET lease_token=NULL,lease_until=NULL WHERE server_id=$1',[serverId]);
    }
    await db.query(`INSERT INTO sync_issues(server_run_id,camera_id,binding_id,code,stage,severity)
      SELECT r.id,c.id,b.id,'CAMERA_CODE_INVALID','identity','warning' FROM cameras c
      JOIN camera_bindings b ON b.camera_id=c.id AND b.valid_to IS NULL
      JOIN camera_current_state st ON st.camera_id=c.id
      JOIN sync_server_runs r ON r.server_id=b.server_id AND r.sequence=st.applied_sequence
      WHERE c.camera_code IS NULL`);
    for(let server=0;server<4;server++)await detectIdentityProposalsInTransaction(db,fixtureId(3000+server*10+2));
    // Explicit synthetic hypotheses; never inferred continuity or permission to correct.
    for(const [kind,subject,related] of [['possible_rename',2006,2005],['possible_replacement',2010,2009]] as const){
      await recordProposal(db,{kind,subject:await readObservation(db,fixtureId(subject)),related:await readObservation(db,fixtureId(related)),
        serverRunId:fixtureId(3002),operatorId:fixtureId(19000)});
    }
    await db.exec('COMMIT');
  }catch(error){await db.exec('ROLLBACK');throw error;}
}
