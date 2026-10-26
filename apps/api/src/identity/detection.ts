import { createHash } from 'node:crypto';
import type { MigrationConnection } from '../database/migrations.js';
import { parseMunicipalDescription } from '../digifort/municipal-code-parser.js';
import { IdentityReviewError, type ProposalKind, type ProposalReceipt, type ReviewState } from './review-types.js';

export interface IdentityObservation {
  camera_id:string;binding_id:string;inventory_id:string;server_id:string;external_name:string;description_original:string|null;camera_code:string|null;
}
const identityProjection=`v.id AS inventory_id,b.id AS binding_id,b.camera_id,b.server_id,b.external_name,v.description_original,c.camera_code`;
export async function currentObservations(db:MigrationConnection,serverId:string,sequence:string):Promise<IdentityObservation[]> {
  return (await db.query<IdentityObservation & Record<string,unknown>>(`SELECT ${identityProjection} FROM camera_inventory_versions v
    JOIN camera_bindings b ON b.id=v.binding_id JOIN cameras c ON c.id=b.camera_id
    JOIN camera_current_state s ON s.camera_id=c.id
    WHERE v.code_parser_version='description-v1' AND v.valid_to IS NULL AND b.valid_to IS NULL AND b.server_id=$1 AND s.binding_id=b.id AND s.applied_sequence=$2
    ORDER BY b.id`,[serverId,sequence])).rows;
}
export async function readObservation(db:MigrationConnection,bindingId:string):Promise<IdentityObservation> {
  const row=(await db.query<IdentityObservation & Record<string,unknown>>(`SELECT ${identityProjection} FROM camera_inventory_versions v
    JOIN camera_bindings b ON b.id=v.binding_id JOIN cameras c ON c.id=b.camera_id
    WHERE b.id=$1 AND v.code_parser_version='description-v1' ORDER BY v.valid_from DESC LIMIT 1`,[bindingId])).rows[0];
  if(!row)throw new IdentityReviewError('INVALID_REQUEST');
  return row;
}

/** Internal only: caller owns a transaction and the server parent lock. */
export async function requireAppliedObservation(db:MigrationConnection,serverRunId:string):Promise<{serverId:string;sequence:string}> {
  const r=(await db.query(`SELECT r.server_id,r.sequence,r.applied_at,c.applied_sequence FROM sync_server_runs r
    JOIN server_sync_control c ON c.server_id=r.server_id WHERE r.id=$1`,[serverRunId])).rows[0];
  if(!r?.applied_at || String(r.sequence)!==String(r.applied_sequence))throw new IdentityReviewError('STALE_OBSERVATION');
  return {serverId:String(r.server_id),sequence:String(r.sequence)};
}

/** Called after ALL camera rows have been persisted, inside the snapshot transaction. */
export async function detectIdentityProposalsInTransaction(db:MigrationConnection,serverRunId:string):Promise<ProposalReceipt[]> {
  // Serialize cross-server detection so the later committer can observe earlier candidates.
  await db.query('SELECT pg_advisory_xact_lock(731005)');
  const run=await requireAppliedObservation(db,serverRunId);
  const observations=await currentObservations(db,run.serverId,run.sequence);
  const receipts:ProposalReceipt[]=[];
  for(const observation of observations){
    const code=parseMunicipalDescription(observation.description_original).cameraCode;
    if(observation.camera_code!==null && observation.camera_code!==code){
      receipts.push(await recordProposal(db,{kind:'confirmed_code_mismatch',subject:observation,serverRunId}));
    }
    if(code===null)continue;
    // Candidates are recomputed from original Description; Name is only a technical key.
    const related=(await db.query(`SELECT c.id AS camera_id,c.camera_code,b.id AS binding_id,b.server_id,b.external_name,v.description_original,v.id AS inventory_id
      FROM cameras c LEFT JOIN camera_bindings b ON b.camera_id=c.id AND b.valid_to IS NULL
      LEFT JOIN camera_inventory_versions v ON v.binding_id=b.id AND v.valid_to IS NULL AND v.code_parser_version='description-v1'
      WHERE c.id<>$1 AND (c.camera_code=$2 OR (municipal_description_code(v.description_original)=$2 AND v.id IS NOT NULL)) ORDER BY c.id`,
    [observation.camera_id,code])).rows;
    for(const other of related){
      const counterpart:IdentityObservation|undefined=other.inventory_id?{
        camera_id:String(other.camera_id),camera_code:other.camera_code as string|null,binding_id:String(other.binding_id),
        inventory_id:String(other.inventory_id),server_id:String(other.server_id),external_name:String(other.external_name),description_original:other.description_original as string|null,
      }:undefined;
      const observed=counterpart?parseMunicipalDescription(counterpart.description_original).cameraCode:null;
      if(other.camera_code!==code && observed!==code)continue;
      receipts.push(await recordProposal(db,{kind:'duplicate_code',subject:observation,related:counterpart,
        relatedCameraId:String(other.camera_id),relatedConfirmed:other.camera_code as string|null,serverRunId}));
    }
  }
  return receipts;
}
interface ProposalInput {
  kind:ProposalKind;subject:IdentityObservation;related?:IdentityObservation;relatedCameraId?:string;relatedConfirmed?:string|null;
  serverRunId:string;operatorId?:string;
}
export async function recordProposal(db:MigrationConnection,input:ProposalInput):Promise<ProposalReceipt> {
  const s=input.subject,r=input.related;
  const observed=parseMunicipalDescription(s.description_original).cameraCode;
  const relatedObserved=r?parseMunicipalDescription(r.description_original).cameraCode:null;
  const identity=['Description',input.kind,s.camera_id,s.binding_id,input.relatedCameraId??r?.camera_id??null,r?.binding_id??null,
    observed,s.camera_code,relatedObserved,input.relatedConfirmed??r?.camera_code??null];
  const key=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const inserted=(await db.query(`INSERT INTO identity_proposals(detection_key,kind,camera_id,binding_id,inventory_id,
    related_camera_id,related_binding_id,related_inventory_id,observed_code,confirmed_code,related_observed_code,related_confirmed_code,source,created_by,detected_server_run_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT(detection_key) DO NOTHING RETURNING id,state,revision`,
  [key,input.kind,s.camera_id,s.binding_id,s.inventory_id,input.relatedCameraId??r?.camera_id??null,r?.binding_id??null,r?.inventory_id??null,
    observed,s.camera_code,relatedObserved,input.relatedConfirmed??r?.camera_code??null,input.operatorId?'operator':'automatic',input.operatorId??null,input.serverRunId])).rows[0];
  const proposal=inserted??(await db.query('SELECT id,state,revision FROM identity_proposals WHERE detection_key=$1',[key])).rows[0];
  const exists=(await db.query('SELECT id FROM identity_proposal_evidence WHERE proposal_id=$1 AND server_run_id=$2',[proposal.id,input.serverRunId])).rows.length>0;
  if(!exists){
    const issue=(await db.query(`INSERT INTO sync_issues(server_run_id,camera_id,binding_id,code,stage,severity)
      VALUES ($1,$2,$3,'IDENTITY_CONFLICT','identity','warning') RETURNING id`,[input.serverRunId,s.camera_id,s.binding_id])).rows[0];
    await db.query(`INSERT INTO identity_proposal_evidence(proposal_id,server_run_id,inventory_id,related_inventory_id,issue_id)
      VALUES ($1,$2,$3,$4,$5)`,[proposal.id,input.serverRunId,s.inventory_id,r?.inventory_id??null,issue.id]);
  }
  return {proposalId:String(proposal.id),kind:input.kind,state:proposal.state as ReviewState,revision:String(proposal.revision),created:Boolean(inserted)};
}
