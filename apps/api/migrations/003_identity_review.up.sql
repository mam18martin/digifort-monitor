-- Review proposals only. No identity assignments, merges or history relocation.
CREATE TABLE identity_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_server_run_id uuid NOT NULL REFERENCES sync_server_runs(id) ON DELETE RESTRICT,
  detection_key text NOT NULL UNIQUE CHECK (detection_key ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('duplicate_code','confirmed_code_mismatch','possible_rename','possible_replacement')),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  inventory_id uuid NOT NULL REFERENCES camera_inventory_versions(id) ON DELETE RESTRICT,
  related_camera_id uuid REFERENCES cameras(id) ON DELETE RESTRICT,
  related_binding_id uuid,
  related_inventory_id uuid REFERENCES camera_inventory_versions(id) ON DELETE RESTRICT,
  observed_code text CHECK (observed_code ~ '^[0-9]+[A-Z]$'),
  confirmed_code text CHECK (confirmed_code ~ '^[0-9]+[A-Z]$'),
  related_observed_code text CHECK (related_observed_code ~ '^[0-9]+[A-Z]$'),
  related_confirmed_code text CHECK (related_confirmed_code ~ '^[0-9]+[A-Z]$'),
  source text NOT NULL CHECK (source IN ('automatic','operator')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(created_at)),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','resolved')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  FOREIGN KEY (camera_id,binding_id) REFERENCES camera_bindings(camera_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (related_camera_id,related_binding_id) REFERENCES camera_bindings(camera_id,id) ON DELETE RESTRICT,
  CHECK ((related_binding_id IS NULL) = (related_inventory_id IS NULL)),
  CHECK (related_binding_id IS NULL OR related_camera_id IS NOT NULL),
  CHECK ((source='automatic' AND created_by IS NULL) OR (source='operator' AND created_by IS NOT NULL)),
  CHECK (kind<>'duplicate_code' OR (observed_code IS NOT NULL AND related_camera_id IS NOT NULL AND related_camera_id<>camera_id)),
  CHECK (kind<>'confirmed_code_mismatch' OR (related_camera_id IS NULL AND confirmed_code IS NOT NULL AND observed_code IS DISTINCT FROM confirmed_code)),
  CHECK (kind NOT IN ('possible_rename','possible_replacement') OR
    (source='operator' AND related_binding_id IS NOT NULL AND related_binding_id<>binding_id)),
  CHECK (kind<>'possible_replacement' OR
    (observed_code IS NOT NULL AND related_observed_code IS NOT NULL AND observed_code<>related_observed_code))
);
CREATE INDEX identity_proposals_queue_idx ON identity_proposals(state,created_at);
CREATE INDEX identity_proposals_camera_idx ON identity_proposals(camera_id,created_at DESC);
CREATE INDEX identity_proposals_related_idx ON identity_proposals(related_camera_id) WHERE related_camera_id IS NOT NULL;
CREATE INDEX identity_open_name_idx ON camera_bindings USING hash(external_name) WHERE valid_to IS NULL;

CREATE TABLE identity_proposal_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES identity_proposals(id) ON DELETE RESTRICT,
  server_run_id uuid NOT NULL REFERENCES sync_server_runs(id) ON DELETE RESTRICT,
  inventory_id uuid NOT NULL REFERENCES camera_inventory_versions(id) ON DELETE RESTRICT,
  related_inventory_id uuid REFERENCES camera_inventory_versions(id) ON DELETE RESTRICT,
  issue_id uuid NOT NULL UNIQUE REFERENCES sync_issues(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(recorded_at)),
  UNIQUE (proposal_id,server_run_id)
);
CREATE INDEX identity_evidence_run_idx ON identity_proposal_evidence(server_run_id);

CREATE TABLE identity_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL UNIQUE,
  proposal_id uuid NOT NULL REFERENCES identity_proposals(id) ON DELETE RESTRICT,
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  resulting_revision bigint GENERATED ALWAYS AS (expected_revision+1) STORED,
  operator_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('note','reject')),
  reason_code text NOT NULL CHECK (reason_code IN ('evidence_reviewed','insufficient_evidence','incorrect_hypothesis','duplicate_observation','requires_policy')),
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK (isfinite(decided_at)),
  UNIQUE (proposal_id,expected_revision)
);
CREATE INDEX identity_review_history_idx ON identity_review_events(proposal_id,resulting_revision);

-- A complete Name match is required, including a terminal delimiter and no suffix.
CREATE FUNCTION identity_name_code(name text) RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE WHEN name COLLATE "C" ~ '^[0-9]+[A-Z][)]$' AND name !~ '[[:space:]]'
    THEN left(name,length(name)-1) ELSE NULL END
$$;

CREATE FUNCTION validate_identity_proposal() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
CREATE TRIGGER identity_proposal_validation BEFORE INSERT ON identity_proposals FOR EACH ROW EXECUTE FUNCTION validate_identity_proposal();

CREATE FUNCTION protect_identity_review() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Identity review history cannot be deleted';
  END IF;
  IF TG_TABLE_NAME<>'identity_proposals' THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Identity evidence and decisions are immutable';
  END IF;
  IF pg_trigger_depth()<>2
    OR (to_jsonb(NEW)-ARRAY['state','revision']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision'])
    OR OLD.state<>'pending' OR NEW.state NOT IN ('pending','rejected') OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Review state changes require an append-only decision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_proposal_guard BEFORE UPDATE OR DELETE ON identity_proposals FOR EACH ROW EXECUTE FUNCTION protect_identity_review();
CREATE TRIGGER identity_evidence_guard BEFORE UPDATE OR DELETE ON identity_proposal_evidence FOR EACH ROW EXECUTE FUNCTION protect_identity_review();
CREATE TRIGGER identity_review_event_guard BEFORE UPDATE OR DELETE ON identity_review_events FOR EACH ROW EXECUTE FUNCTION protect_identity_review();

CREATE FUNCTION validate_identity_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
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
CREATE TRIGGER identity_evidence_validation BEFORE INSERT ON identity_proposal_evidence FOR EACH ROW EXECUTE FUNCTION validate_identity_evidence();

CREATE FUNCTION apply_identity_review_event() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE proposal identity_proposals%ROWTYPE;
BEGIN
  IF NEW.action NOT IN ('note','reject') THEN
    RAISE EXCEPTION USING ERRCODE='P3003', MESSAGE='Approval and identity application require an approved policy';
  END IF;
  SELECT * INTO proposal FROM identity_proposals WHERE id=NEW.proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Unknown identity proposal'; END IF;
  IF proposal.revision<>NEW.expected_revision THEN
    RAISE EXCEPTION USING ERRCODE='P3001', MESSAGE='Review revision conflict';
  END IF;
  IF proposal.state<>'pending' THEN
    RAISE EXCEPTION USING ERRCODE='P3002', MESSAGE='Review is closed';
  END IF;
  UPDATE identity_proposals SET state=CASE WHEN NEW.action='reject' THEN 'rejected' ELSE 'pending' END,revision=revision+1 WHERE id=NEW.proposal_id;
  RETURN NEW;
END $$;
CREATE TRIGGER identity_review_decision BEFORE INSERT ON identity_review_events FOR EACH ROW EXECUTE FUNCTION apply_identity_review_event();
