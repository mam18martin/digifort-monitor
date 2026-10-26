-- Destructive removal of review data only; never moves camera identities or history.
DROP TABLE identity_review_events;
DROP TABLE identity_proposal_evidence;
DROP TABLE identity_proposals;
DROP INDEX identity_open_name_idx;
DROP FUNCTION apply_identity_review_event();
DROP FUNCTION validate_identity_evidence();
DROP FUNCTION protect_identity_review();
DROP FUNCTION validate_identity_proposal();
DROP FUNCTION identity_name_code(text);
