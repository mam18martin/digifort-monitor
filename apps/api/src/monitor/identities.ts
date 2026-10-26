import type { ReadDatabase } from './repository.js';

// Saved proposals retain captured evidence. Unconfirmed inventory is a derived condition,
// not an operator decision. Neither projection writes or interprets Description as identity.
const incidents=`WITH incidents AS (
 SELECT 'p-'||p.id AS id,p.id AS "proposalId",p.kind,p.state,p.source,
 p.camera_id AS "cameraId",b.external_name AS name,b.server_id AS "serverId",d.name AS "serverName",
 p.observed_code AS "candidateCode",p.confirmed_code AS "confirmedCode",c.camera_code AS "currentConfirmedCode",
 p.related_camera_id AS "relatedCameraId",rb.external_name AS "relatedName",p.related_observed_code AS "relatedCandidateCode",
 p.created_at AS "detectedAt",p.inventory_id AS "inventoryId",p.detected_server_run_id AS "serverRunId",
 'recorded'::text AS "stateSource",p.revision::text AS revision,p.code_source AS "codeSource",
 (SELECT count(*)::int FROM identity_proposal_evidence e WHERE e.proposal_id=p.id) AS "evidenceCount"
 FROM identity_proposals p JOIN cameras c ON c.id=p.camera_id JOIN camera_bindings b ON b.id=p.binding_id
 JOIN digifort_servers d ON d.id=b.server_id LEFT JOIN camera_bindings rb ON rb.id=p.related_binding_id
 UNION ALL
 SELECT 'u-'||c.id,NULL::uuid,'unconfirmed_code','pending','inventory',c.id,b.external_name,b.server_id,d.name,
 CASE WHEN v.code_parser_version='description-v1' THEN municipal_description_code(v.description_original) ELSE NULL END,NULL::text,c.camera_code,NULL::uuid,NULL::text,NULL::text,
 COALESCE(v.first_observed_at,c.created_at),v.id,v.source_server_run_id,'derived',NULL::text,'Description',CASE WHEN v.id IS NULL THEN 0 ELSE 1 END
 FROM cameras c LEFT JOIN camera_bindings b ON b.camera_id=c.id AND b.valid_to IS NULL
 LEFT JOIN digifort_servers d ON d.id=b.server_id LEFT JOIN camera_inventory_versions v ON v.binding_id=b.id AND v.valid_to IS NULL
 WHERE c.camera_code IS NULL
)`;
export function identityQueries(db:ReadDatabase){
 return {
  async identities(input:{kind:string;server:string;state:string;page:number;pageSize:number}){
   const result=await db.query(`${incidents}, filtered AS (SELECT * FROM incidents
    WHERE ($1='' OR kind=$1) AND ($2='' OR "serverId"::text=$2) AND ($3='' OR state=$3)),
    page AS (SELECT * FROM filtered ORDER BY "detectedAt" DESC,id LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*)::int FROM filtered) AS total,
    COALESCE((SELECT json_agg(page) FROM page),'[]'::json) AS items`,
    [input.kind,input.server,input.state,input.pageSize,(input.page-1)*input.pageSize]);
   return {...result.rows[0],page:input.page,pageSize:input.pageSize,readOnly:true};
  },
  async identity(id:string){
   // One statement provides a consistent snapshot, including evidence and audit events.
   const result=await db.query(`${incidents} SELECT i.*,
    COALESCE((SELECT json_agg(evidence ORDER BY evidence."recordedAt",evidence.id) FROM (
     SELECT e.id,e.server_run_id AS "serverRunId",e.inventory_id AS "inventoryId",e.recorded_at AS "recordedAt",s.code
     FROM identity_proposal_evidence e JOIN sync_issues s ON s.id=e.issue_id WHERE e.proposal_id=i."proposalId"
     UNION ALL
     SELECT s.id,s.server_run_id,i."inventoryId",s.created_at,s.code FROM sync_issues s
     WHERE i."proposalId" IS NULL AND s.camera_id=i."cameraId" AND s.binding_id=(SELECT binding_id FROM camera_inventory_versions WHERE id=i."inventoryId")
     AND s.code IN ('CAMERA_CODE_ABSENT','CAMERA_CODE_INVALID','CAMERA_TYPE_UNKNOWN','CAMERA_CODE_REVIEW_REQUIRED')
    ) evidence),'[]'::json) AS evidence,
    COALESCE((SELECT json_agg(audit ORDER BY audit."decidedAt") FROM (
     SELECT action,reason_code AS "reasonCode",operator_id AS "operatorId",decided_at AS "decidedAt",resulting_revision::text AS revision
     FROM identity_review_events WHERE proposal_id=i."proposalId"
    ) audit),'[]'::json) AS decisions
    FROM incidents i WHERE i.id=$1`,[id]);
   return result.rows[0]?{...result.rows[0],readOnly:true,applicationBlocked:true}:null;
  }
 };
}
