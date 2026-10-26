import { identityQueries } from './identities.js';
import type { MigrationConnection } from '../database/migrations.js';
export type ReadDatabase=Pick<MigrationConnection,'query'>;
export const freshnessSeconds=180;

// A failed attempt never refreshes camera observations. Server failure is a separate dimension.
const projection=`WITH clock AS (SELECT statement_timestamp() AS now), cameras_view AS (
 SELECT c.id,c.camera_code AS "cameraCode",b.external_name AS name,v.description_original AS description,
 d.id AS "serverId",d.name AS "serverName",s.active,s.working,s.active_source AS "activeSource",
 s.last_snapshot_success_at AS "observedAt",s.active_observed_at AS "activeObservedAt",s.working_observed_at AS "workingObservedAt",
 s.status_coverage AS coverage,clock.now AS "evaluatedAt",
 CASE WHEN s.last_snapshot_success_at IS NULL THEN NULL ELSE greatest(0,extract(epoch FROM clock.now-s.last_snapshot_success_at))::int END AS "ageSeconds",
 CASE WHEN s.last_snapshot_success_at IS NULL THEN 'never_seen'
   WHEN s.last_snapshot_success_at>clock.now THEN 'future_observation'
   WHEN s.last_snapshot_success_at<clock.now-interval '180 seconds' THEN 'stale'
   WHEN h.server_id IS NULL OR h.consecutive_failures>0 OR sh.transport_state<>'responding'
     OR sh.query_state NOT IN ('healthy','partial') OR h.last_success_at IS NULL
     OR h.last_success_at>clock.now OR h.last_success_at<clock.now-interval '180 seconds' THEN 'server_problem'
   WHEN s.inventory_presence<>'present' OR s.status_coverage<>'matched' THEN 'incomplete'
   WHEN s.active IS NULL OR s.active_observed_at IS NULL OR s.active_observed_at>clock.now
     OR s.active_observed_at<clock.now-interval '180 seconds' THEN 'unknown_flags'
   WHEN s.active=false THEN 'inactive'
   WHEN s.working IS NULL OR s.working_observed_at IS NULL OR s.working_observed_at>clock.now
     OR s.working_observed_at<clock.now-interval '180 seconds' THEN 'unknown_flags'
   WHEN s.working=true THEN 'operational' ELSE 'down' END AS quality
 FROM cameras c LEFT JOIN camera_current_state s ON s.camera_id=c.id
 LEFT JOIN camera_bindings b ON b.camera_id=c.id AND b.valid_to IS NULL
 LEFT JOIN digifort_servers d ON d.id=b.server_id
 LEFT JOIN camera_inventory_versions v ON v.camera_id=c.id AND v.valid_to IS NULL
 LEFT JOIN server_current_health h ON h.server_id=d.id LEFT JOIN server_health_changes sh ON sh.id=h.health_change_id
 CROSS JOIN clock WHERE c.retired_at IS NULL
), classified AS (SELECT *,CASE WHEN quality IN ('operational','down','inactive') THEN quality ELSE 'unknown' END AS status FROM cameras_view)`;

export function monitoringRepository(db:ReadDatabase){
  async function servers(){
    return (await db.query(`SELECT d.id,d.name,h.last_attempt_at AS "lastAttemptAt",h.last_response_at AS "lastResponseAt",
      h.last_success_at AS "lastSuccessAt",coalesce(h.consecutive_failures,0) AS "consecutiveFailures",
      coalesce(e.transport_state,'unknown') AS transport,coalesce(e.query_state,'unknown') AS query,
      CASE WHEN h.server_id IS NULL THEN 'unknown'
        WHEN h.last_attempt_at>statement_timestamp() OR h.last_attempt_at<statement_timestamp()-interval '180 seconds' THEN 'stale'
        WHEN e.transport_state='unreachable' THEN 'unreachable'
        WHEN h.consecutive_failures>0 OR e.transport_state<>'responding' OR e.query_state NOT IN ('healthy','partial') THEN 'degraded'
        WHEN h.last_success_at IS NULL OR h.last_success_at>statement_timestamp() OR h.last_success_at<statement_timestamp()-interval '180 seconds' THEN 'stale' ELSE 'healthy' END AS health,
      (SELECT count(*)::int FROM camera_bindings b JOIN cameras c ON c.id=b.camera_id WHERE b.server_id=d.id AND b.valid_to IS NULL AND c.retired_at IS NULL) AS "cameraCount"
      FROM digifort_servers d LEFT JOIN server_current_health h ON h.server_id=d.id
      LEFT JOIN server_health_changes e ON e.id=h.health_change_id WHERE d.retired_at IS NULL ORDER BY d.name`)).rows;
  }
  return {
    ...identityQueries(db),
    servers,
    async overview(){
      const [summary,serverRows]=await Promise.all([db.query(`${projection} SELECT count(*)::int AS total,
        count(*) FILTER(WHERE status='operational')::int AS operational,count(*) FILTER(WHERE status='down')::int AS down,
        count(*) FILTER(WHERE status='unknown')::int AS unknown,count(*) FILTER(WHERE status='inactive')::int AS inactive,
        statement_timestamp() AS "generatedAt" FROM classified`),servers()]);
      return {...summary.rows[0],serversWithProblems:serverRows.filter(s=>s.health!=='healthy').length,servers:serverRows,freshnessSeconds,demo:true};
    },
    async cameras(input:{q:string;server:string;status:string;page:number;pageSize:number}){
      const pattern='%'+input.q.replace(/[\\%_]/g,'\\$&')+'%';
      const data=(await db.query(`${projection}, filtered AS (SELECT * FROM classified WHERE
        ($1='' OR coalesce("cameraCode",'') ILIKE $2 OR coalesce(name,'') ILIKE $2 OR coalesce(description,'') ILIKE $2)
        AND ($3='' OR "serverId"::text=$3) AND ($4='' OR status=$4))
        SELECT jsonb_build_object('total',(SELECT count(*)::int FROM filtered),'items',coalesce((SELECT jsonb_agg(x) FROM
        (SELECT * FROM filtered ORDER BY "cameraCode" NULLS LAST,name,id LIMIT $5 OFFSET $6) x),'[]'::jsonb)) AS data`,
      [input.q,pattern,input.server,input.status,input.pageSize,(input.page-1)*input.pageSize])).rows[0].data;
      return {...data as object,page:input.page,pageSize:input.pageSize,freshnessSeconds};
    },
    async camera(id:string){
      const row=(await db.query(`${projection} SELECT * FROM classified WHERE id=$1`,[id])).rows[0];
      if(!row)return null;
      const events=(await db.query(`SELECT e.id,e.observed_at AS "observedAt",e.last_confirmed_at AS "lastConfirmedAt",e.active,e.working,
        e.active_source AS "activeSource",e.status_coverage AS coverage,e.reason,d.name AS "serverName"
        FROM camera_state_changes e JOIN digifort_servers d ON d.id=e.server_id WHERE e.camera_id=$1
        ORDER BY e.state_sequence DESC LIMIT 100`,[id])).rows;
      return {...row,events,freshnessSeconds};
    },
  };
}
export type MonitoringRepository=ReturnType<typeof monitoringRepository>;
