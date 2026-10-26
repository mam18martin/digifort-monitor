-- Refuse a downgrade that would erase the source provenance of new observations.
DO $$ BEGIN
 IF current_setting('digifort.full_schema_rollback',true) IS DISTINCT FROM 'yes' AND (EXISTS(SELECT 1 FROM identity_proposals WHERE code_source='Description') OR
    EXISTS(SELECT 1 FROM camera_inventory_versions WHERE code_parser_version='description-v1')) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Description observations require retention of migration 004';
 END IF;
END $$;
DROP INDEX inventory_description_candidate_idx;
DROP TRIGGER inventory_description_candidate ON camera_inventory_versions;
DROP FUNCTION validate_description_candidate();
CREATE OR REPLACE FUNCTION validate_identity_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE inv camera_inventory_versions%ROWTYPE; binding camera_bindings%ROWTYPE; code text; original_name text;
BEGIN
  IF NEW.state<>'pending' OR NEW.revision<>1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Proposals must begin pending';
  END IF;
  SELECT * INTO inv FROM camera_inventory_versions WHERE id=NEW.inventory_id;
  SELECT * INTO binding FROM camera_bindings WHERE id=NEW.binding_id;
  SELECT camera_code INTO code FROM cameras WHERE id=NEW.camera_id;
  IF inv.camera_id IS DISTINCT FROM NEW.camera_id OR inv.binding_id IS DISTINCT FROM NEW.binding_id
    OR NEW.observed_code IS DISTINCT FROM identity_name_code(binding.external_name) OR NEW.confirmed_code IS DISTINCT FROM code THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Proposal identity evidence does not match its referenced entities';
  END IF;
  original_name:=binding.external_name;
  PERFORM 1 FROM sync_server_runs r JOIN camera_current_state s ON s.camera_id=NEW.camera_id
    WHERE r.id=NEW.detected_server_run_id AND r.server_id=binding.server_id AND r.applied_at IS NOT NULL
      AND s.binding_id=NEW.binding_id AND s.applied_sequence=r.sequence;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Proposal requires a referenced applied observation'; END IF;
  IF NEW.related_camera_id IS NOT NULL THEN
    SELECT camera_code INTO code FROM cameras WHERE id=NEW.related_camera_id;
    IF NEW.related_confirmed_code IS DISTINCT FROM code THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Related confirmed code does not match';
    END IF;
    IF NEW.related_binding_id IS NOT NULL THEN
      SELECT * INTO inv FROM camera_inventory_versions WHERE id=NEW.related_inventory_id;
      SELECT * INTO binding FROM camera_bindings WHERE id=NEW.related_binding_id;
      IF inv.camera_id IS DISTINCT FROM NEW.related_camera_id OR inv.binding_id IS DISTINCT FROM NEW.related_binding_id
        OR NEW.related_observed_code IS DISTINCT FROM identity_name_code(binding.external_name) THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Related observation does not match its binding';
      END IF;
      IF NEW.kind='possible_rename' AND binding.external_name=original_name THEN
        RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A possible rename requires different technical names';
      END IF;
    ELSIF NEW.related_observed_code IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Observed code requires a related binding';
    END IF;
  ELSIF NEW.related_confirmed_code IS NOT NULL OR NEW.related_observed_code IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Related codes require a related camera';
  END IF;
  IF NEW.kind='duplicate_code' AND NEW.observed_code IS DISTINCT FROM NEW.related_observed_code
    AND NEW.observed_code IS DISTINCT FROM NEW.related_confirmed_code THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Duplicate proposal requires matching code evidence';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION validate_identity_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE proposal identity_proposals%ROWTYPE;
BEGIN
  SELECT * INTO proposal FROM identity_proposals WHERE id=NEW.proposal_id;
  IF NEW.related_inventory_id IS NOT NULL AND proposal.related_binding_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Unexpected counterpart observation';
  END IF;
  PERFORM 1 FROM camera_inventory_versions v JOIN camera_bindings b ON b.id=v.binding_id
    JOIN sync_server_runs r ON r.id=NEW.server_run_id
    JOIN camera_current_state s ON s.camera_id=v.camera_id
    JOIN sync_issues i ON i.id=NEW.issue_id
    WHERE v.id=NEW.inventory_id AND v.binding_id=proposal.binding_id AND v.valid_to IS NULL
      AND s.binding_id=b.id AND s.applied_sequence=r.sequence AND b.server_id=r.server_id AND r.applied_at IS NOT NULL
      AND i.server_run_id=r.id AND i.camera_id=v.camera_id AND i.binding_id=b.id AND i.code='IDENTITY_CONFLICT';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Evidence requires an applied observation and its sanitized issue'; END IF;
  IF proposal.related_binding_id IS NOT NULL THEN
    PERFORM 1 FROM camera_inventory_versions WHERE id=NEW.related_inventory_id AND binding_id=proposal.related_binding_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Evidence counterpart does not match the proposal'; END IF;
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE identity_proposals DROP COLUMN code_source;
DROP FUNCTION municipal_description_code(text);
