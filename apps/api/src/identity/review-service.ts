import type { MigrationConnection } from '../database/migrations.js';
import { currentObservations, detectIdentityProposalsInTransaction, readObservation, recordProposal, requireAppliedObservation } from './detection.js';
import { IdentityReviewError, type DecisionReceipt, type ProposalReceipt, type ReviewAction, type ReviewReason } from './review-types.js';

const validUuid=(v:string)=>typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const invalid=():never=>{throw new IdentityReviewError('INVALID_REQUEST');};
async function transaction<T>(db:MigrationConnection,work:()=>Promise<T>,readOnly=false):Promise<T>{
  try{
    await db.exec(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
    await db.exec("SET LOCAL search_path=public; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const result=await work();await db.exec('COMMIT');return result;
  }catch(error){
    await db.exec('ROLLBACK').catch(()=>{});
    if(error instanceof IdentityReviewError)throw error;
    const code=typeof error==='object' && error!==null && 'code' in error?error.code:undefined;
    if(code==='P3001')throw new IdentityReviewError('REVISION_CONFLICT');
    if(code==='P3002')throw new IdentityReviewError('REVIEW_CLOSED');
    if(code==='P3003')throw new IdentityReviewError('POLICY_REQUIRED');
    throw new IdentityReviewError('PERSISTENCE_FAILED');
  }
}
async function lockServerRun(db:MigrationConnection,id:string){
  const row=(await db.query('SELECT server_id FROM sync_server_runs WHERE id=$1',[id])).rows[0];
  if(!row)throw new IdentityReviewError('INVALID_REQUEST');
  await db.query('SELECT id FROM digifort_servers WHERE id=$1 FOR UPDATE',[row.server_id]);
}
/** Explicit re-scan of the latest applied server execution; no remote access. */
export async function detectIdentityProposals(db:MigrationConnection,serverRunId:string):Promise<ProposalReceipt[]>{
  if(!validUuid(serverRunId))invalid();
  return transaction(db,async()=>{await lockServerRun(db,serverRunId);return detectIdentityProposalsInTransaction(db,serverRunId);});
}
/** An operator-supplied hypothesis is evidence to review, never a claim of continuity. */
export async function registerIdentityHypothesis(db:MigrationConnection,input:{
  kind:'possible_rename'|'possible_replacement';serverRunId:string;bindingId:string;relatedBindingId:string;operatorId:string;
}):Promise<ProposalReceipt>{
  if(!['possible_rename','possible_replacement'].includes(input.kind) || ![input.serverRunId,input.bindingId,input.relatedBindingId,input.operatorId].every(validUuid)
    || input.bindingId===input.relatedBindingId)invalid();
  return transaction(db,async()=>{
    await lockServerRun(db,input.serverRunId);await db.query('SELECT pg_advisory_xact_lock(731005)');
    const run=await requireAppliedObservation(db,input.serverRunId);
    const subject=(await currentObservations(db,run.serverId,run.sequence)).find(r=>r.binding_id===input.bindingId);
    if(!subject)throw new IdentityReviewError('STALE_OBSERVATION');
    const related=await readObservation(db,input.relatedBindingId);
    if(input.kind==='possible_rename' && subject.external_name===related.external_name)invalid();
    return recordProposal(db,{kind:input.kind,subject,related,serverRunId:input.serverRunId,operatorId:input.operatorId});
  });
}
export async function reviewIdentityProposal(db:MigrationConnection,input:{
  proposalId:string;requestKey:string;expectedRevision:string;operatorId:string;action:ReviewAction;reasonCode:ReviewReason;
}):Promise<DecisionReceipt>{
  if(['approve','resolve','merge','apply'].includes(input.action as string))throw new IdentityReviewError('POLICY_REQUIRED');
  if(![input.proposalId,input.requestKey,input.operatorId].every(validUuid) || !/^[1-9][0-9]*$/.test(input.expectedRevision)
    || !['note','reject'].includes(input.action)
    || !['evidence_reviewed','insufficient_evidence','incorrect_hypothesis','duplicate_observation','requires_policy'].includes(input.reasonCode))invalid();
  return transaction(db,async()=>{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,731006))',[input.requestKey]);
    const prior=(await db.query('SELECT * FROM identity_review_events WHERE request_key=$1',[input.requestKey])).rows[0];
    if(prior){
      if(prior.proposal_id!==input.proposalId || String(prior.expected_revision)!==input.expectedRevision || prior.operator_id!==input.operatorId
        || prior.action!==input.action || prior.reason_code!==input.reasonCode)throw new IdentityReviewError('IDEMPOTENCY_CONFLICT');
      return receipt(prior,true);
    }
    const row=(await db.query(`INSERT INTO identity_review_events(request_key,proposal_id,expected_revision,operator_id,action,reason_code)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,[input.requestKey,input.proposalId,input.expectedRevision,input.operatorId,input.action,input.reasonCode])).rows[0];
    return receipt(row,false);
  });
}
function receipt(row:Record<string,unknown>,replayed:boolean):DecisionReceipt{
  return {decisionId:String(row.id),proposalId:String(row.proposal_id),revision:String(row.resulting_revision),state:row.action==='reject'?'rejected':'pending',replayed};
}
/** No operator approval policy or municipal correction operation is authorized yet. */
export function applyIdentityProposal(_db:MigrationConnection,_input:{proposalId:string;operatorId:string;expectedRevision:string}):never{
  throw new IdentityReviewError('POLICY_REQUIRED');
}

/** A consistent review snapshot. All fields are codes, UUID references or audit metadata. */
export async function readIdentityProposal(db:MigrationConnection,proposalId:string){
  if(!validUuid(proposalId))invalid();
  return transaction(db,async()=>{
    const proposal=(await db.query('SELECT id,code_source,kind,camera_id,binding_id,inventory_id,related_camera_id,related_binding_id,related_inventory_id,observed_code,confirmed_code,related_observed_code,related_confirmed_code,source,created_by,created_at,state,revision,detected_server_run_id FROM identity_proposals WHERE id=$1',[proposalId])).rows[0];
    if(!proposal)throw new IdentityReviewError('INVALID_REQUEST');
    const evidence=(await db.query('SELECT id,proposal_id,server_run_id,inventory_id,related_inventory_id,issue_id,recorded_at FROM identity_proposal_evidence WHERE proposal_id=$1 ORDER BY recorded_at,id',[proposalId])).rows;
    const decisions=(await db.query('SELECT id,proposal_id,request_key,expected_revision,resulting_revision,operator_id,action,reason_code,decided_at FROM identity_review_events WHERE proposal_id=$1 ORDER BY resulting_revision',[proposalId])).rows;
    return {proposal,evidence,decisions,applicationBlocked:true as const};
  },true);
}
