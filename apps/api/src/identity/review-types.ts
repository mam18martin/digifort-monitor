export type ProposalKind='duplicate_code'|'confirmed_code_mismatch'|'possible_rename'|'possible_replacement';
export type ReviewState='pending'|'approved'|'rejected'|'resolved';
export type ReviewAction='note'|'reject';
export type ReviewReason='evidence_reviewed'|'insufficient_evidence'|'incorrect_hypothesis'|'duplicate_observation'|'requires_policy';
export interface ProposalReceipt {proposalId:string;kind:ProposalKind;state:ReviewState;revision:string;created:boolean;}
export interface DecisionReceipt {decisionId:string;proposalId:string;revision:string;state:ReviewState;replayed:boolean;}
export class IdentityReviewError extends Error {
  constructor(public readonly code:'INVALID_REQUEST'|'STALE_OBSERVATION'|'REVISION_CONFLICT'|'REVIEW_CLOSED'|'POLICY_REQUIRED'|'IDEMPOTENCY_CONFLICT'|'PERSISTENCE_FAILED') {
    super(`Identity review: ${code}`);this.name='IdentityReviewError';
  }
}
