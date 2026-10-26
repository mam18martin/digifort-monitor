-- Description becomes the official candidate source. No camera identities or history are rewritten.
ALTER TABLE identity_proposals ADD COLUMN code_source text NOT NULL DEFAULT 'Name' CHECK (code_source IN ('Name','Description'));
ALTER TABLE identity_proposals ALTER COLUMN code_source SET DEFAULT 'Description';

CREATE FUNCTION municipal_description_code(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE parts text[]; suffix text;
BEGIN
  IF value COLLATE "C" ~ '[[:cntrl:]]' THEN RETURN NULL; END IF;
  parts:=regexp_match(value COLLATE "C",'^([0-9]+)([A-Z])([)])?');
  IF parts IS NULL THEN RETURN NULL; END IF;
  suffix:=substr(value,length(parts[1])+1+coalesce(length(parts[3]),0)+1);
  IF parts[3] IS NOT NULL THEN
    IF left(suffix,1)=')' THEN RETURN NULL; END IF;
  ELSIF suffix<>'' AND left(suffix,1)<>' ' THEN RETURN NULL;
  END IF;
  RETURN parts[1]||parts[2];
END $$;

CREATE FUNCTION validate_description_candidate() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE expected_code text; expected_status text; trim_chars text;
BEGIN
  -- Immutable legacy inventory remains evidence of its original source, not a fallback.
  IF NEW.code_parser_version IS DISTINCT FROM 'description-v1' THEN RETURN NEW; END IF;
  expected_code:=municipal_description_code(NEW.description_original);
  trim_chars:=chr(32)||chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(160)||chr(5760)||
    chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||
    chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279);
  expected_status:=CASE WHEN NEW.description_original IS NULL OR btrim(NEW.description_original,trim_chars)='' THEN 'absent'
    WHEN expected_code IS NULL THEN 'invalid'
    WHEN EXISTS(SELECT 1 FROM camera_types WHERE camera_types.code=right(expected_code,1)) THEN 'valid' ELSE 'unknown_type' END;
  IF NEW.code_candidate IS DISTINCT FROM expected_code
    OR NEW.number_candidate IS DISTINCT FROM left(expected_code,length(expected_code)-1)
    OR NEW.type_code_candidate IS DISTINCT FROM right(expected_code,1)
    OR NEW.code_parse_status IS DISTINCT FROM expected_status THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Candidate must match the original Description';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_description_candidate BEFORE INSERT ON camera_inventory_versions
FOR EACH ROW EXECUTE FUNCTION validate_description_candidate();

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
    OR NEW.code_source<>'Description' OR inv.code_parser_version IS DISTINCT FROM 'description-v1'
    OR NEW.observed_code IS DISTINCT FROM municipal_description_code(inv.description_original) OR NEW.confirmed_code IS DISTINCT FROM code THEN
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
        OR inv.code_parser_version IS DISTINCT FROM 'description-v1'
        OR NEW.related_observed_code IS DISTINCT FROM municipal_description_code(inv.description_original) THEN
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
      AND proposal.code_source='Description' AND v.code_parser_version='description-v1'
      AND municipal_description_code(v.description_original) IS NOT DISTINCT FROM proposal.observed_code
      AND i.server_run_id=r.id AND i.camera_id=v.camera_id AND i.binding_id=b.id AND i.code='IDENTITY_CONFLICT';
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Evidence requires an applied observation and its sanitized issue'; END IF;
  IF proposal.related_binding_id IS NOT NULL THEN
    PERFORM 1 FROM camera_inventory_versions WHERE id=NEW.related_inventory_id AND binding_id=proposal.related_binding_id AND code_parser_version='description-v1'
      AND municipal_description_code(description_original) IS NOT DISTINCT FROM proposal.related_observed_code;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Evidence counterpart does not match the proposal'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX inventory_description_candidate_idx ON camera_inventory_versions(municipal_description_code(description_original)) WHERE valid_to IS NULL AND code_parser_version='description-v1';
