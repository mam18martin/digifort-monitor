-- Tracking only: no scheduler, requests, credentials or identity assignments.
CREATE TABLE sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL UNIQUE,
  trigger text NOT NULL CHECK (trigger IN ('manual','schedule','recovery')),
  started_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(started_at)),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','success','partial','failed','cancelled','abandoned')),
  CHECK ((outcome = 'running' AND finished_at IS NULL) OR
    (outcome <> 'running' AND finished_at IS NOT NULL AND isfinite(finished_at) AND finished_at >= started_at))
);
CREATE INDEX sync_runs_started_idx ON sync_runs(started_at DESC);

CREATE TABLE server_sync_control (
  server_id uuid PRIMARY KEY REFERENCES digifort_servers(id) ON DELETE RESTRICT,
  issued_sequence bigint NOT NULL DEFAULT 0 CHECK (issued_sequence >= 0),
  applied_sequence bigint NOT NULL DEFAULT 0 CHECK (applied_sequence BETWEEN 0 AND issued_sequence),
  lease_token uuid,
  lease_until timestamptz,
  CHECK ((lease_token IS NULL AND lease_until IS NULL) OR
    (lease_token IS NOT NULL AND lease_until IS NOT NULL AND isfinite(lease_until)))
);

CREATE TABLE sync_server_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES sync_runs(id) ON DELETE RESTRICT,
  server_id uuid NOT NULL REFERENCES digifort_servers(id) ON DELETE RESTRICT,
  sequence bigint NOT NULL CHECK (sequence > 0),
  config_revision bigint NOT NULL CHECK (config_revision > 0),
  lease_token uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(started_at)),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','success','partial','failed','cancelled','abandoned')),
  inventory_completeness text NOT NULL DEFAULT 'unknown' CHECK (inventory_completeness IN ('unknown','complete','incomplete')),
  inventory_count integer CHECK (inventory_count >= 0),
  status_count integer CHECK (status_count >= 0),
  matched_count integer CHECK (matched_count >= 0),
  missing_status_count integer CHECK (missing_status_count >= 0),
  orphan_status_count integer CHECK (orphan_status_count >= 0),
  applied_at timestamptz,
  UNIQUE (run_id, server_id), UNIQUE (server_id, sequence), UNIQUE (server_id, id),
  CHECK ((outcome = 'running' AND finished_at IS NULL) OR
    (outcome <> 'running' AND finished_at IS NOT NULL AND isfinite(finished_at) AND finished_at >= started_at)),
  CHECK (applied_at IS NULL OR (outcome IN ('success','partial') AND isfinite(applied_at)
    AND applied_at BETWEEN started_at AND finished_at)),
  CHECK (matched_count IS NULL OR (inventory_count IS NOT NULL AND status_count IS NOT NULL
    AND missing_status_count IS NOT NULL AND orphan_status_count IS NOT NULL
    AND matched_count::bigint + missing_status_count = inventory_count
    AND matched_count::bigint + orphan_status_count = status_count)),
  CHECK (matched_count IS NOT NULL OR (missing_status_count IS NULL AND orphan_status_count IS NULL)),
  CHECK (outcome <> 'success' OR (applied_at IS NOT NULL AND inventory_completeness = 'complete'
    AND matched_count IS NOT NULL AND missing_status_count = 0 AND orphan_status_count = 0))
);
CREATE INDEX sync_server_runs_history_idx ON sync_server_runs(server_id, started_at DESC);
CREATE INDEX sync_server_runs_run_idx ON sync_server_runs(run_id);

CREATE TABLE sync_endpoint_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_run_id uuid NOT NULL REFERENCES sync_server_runs(id) ON DELETE RESTRICT,
  endpoint text NOT NULL CHECK (endpoint IN ('GetCameras','GetStatus')),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  started_at timestamptz NOT NULL CHECK (isfinite(started_at)),
  finished_at timestamptz NOT NULL CHECK (isfinite(finished_at) AND finished_at >= started_at),
  outcome text NOT NULL CHECK (outcome IN ('success','http_error','transport_error','invalid_response','configuration_error')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error_code text CHECK (error_code IN ('CONFIGURATION','HTTP_ERROR','NETWORK_ERROR','TIMEOUT','RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_RESPONSE','DUPLICATE_NAME')),
  response_bytes bigint CHECK (response_bytes >= 0),
  row_count integer CHECK (row_count >= 0),
  completeness text NOT NULL DEFAULT 'unknown' CHECK (completeness IN ('unknown','complete','incomplete')),
  UNIQUE (server_run_id, endpoint, attempt_no), UNIQUE (server_run_id, id),
  CHECK ((outcome = 'success' AND error_code IS NULL AND http_status BETWEEN 200 AND 299 AND http_status IS NOT NULL AND row_count IS NOT NULL)
    OR (outcome <> 'success' AND error_code IS NOT NULL AND row_count IS NULL AND completeness = 'unknown')),
  CHECK (outcome <> 'http_error' OR (http_status IS NOT NULL AND (http_status < 200 OR http_status >= 300) AND error_code = 'HTTP_ERROR')),
  CHECK (outcome <> 'transport_error' OR (http_status IS NULL AND error_code IN ('NETWORK_ERROR','TIMEOUT'))),
  CHECK (outcome <> 'configuration_error' OR (http_status IS NULL AND error_code = 'CONFIGURATION')),
  CHECK (outcome <> 'invalid_response' OR error_code IN ('RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_RESPONSE','DUPLICATE_NAME'))
);

CREATE TABLE sync_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_run_id uuid NOT NULL REFERENCES sync_server_runs(id) ON DELETE RESTRICT,
  endpoint_attempt_id uuid,
  camera_id uuid REFERENCES cameras(id) ON DELETE RESTRICT,
  binding_id uuid,
  code text NOT NULL CHECK (code IN ('CONFIGURATION','HTTP_ERROR','NETWORK_ERROR','TIMEOUT','RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_RESPONSE','DUPLICATE_NAME',
    'PERSISTENCE_FAILED','INCOMPLETE_COVERAGE','IDENTITY_CONFLICT','WORKER_ABANDONED','STALE_RESULT_DISCARDED','CAMERA_CODE_ABSENT','CAMERA_CODE_INVALID','CAMERA_TYPE_UNKNOWN','CAMERA_CODE_CONFLICT','CAMERA_CODE_REVIEW_REQUIRED','METADATA_REDACTED')),
  stage text NOT NULL CHECK (stage IN ('configuration','transport','validation','identity','persistence','coordination')),
  severity text NOT NULL CHECK (severity IN ('info','warning','error')),
  retryable boolean NOT NULL DEFAULT false,
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
  created_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(created_at)),
  FOREIGN KEY (server_run_id, endpoint_attempt_id) REFERENCES sync_endpoint_attempts(server_run_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (camera_id, binding_id) REFERENCES camera_bindings(camera_id, id) ON DELETE RESTRICT,
  CHECK (binding_id IS NULL OR camera_id IS NOT NULL)
);
CREATE INDEX sync_issues_run_idx ON sync_issues(server_run_id, severity);
CREATE INDEX sync_issues_camera_idx ON sync_issues(camera_id, created_at DESC) WHERE camera_id IS NOT NULL;

CREATE TABLE camera_state_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  server_id uuid NOT NULL,
  server_run_id uuid NOT NULL,
  state_sequence bigint NOT NULL CHECK (state_sequence > 0),
  observation_epoch bigint NOT NULL CHECK (observation_epoch > 0),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  recorded_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(recorded_at)),
  last_confirmed_at timestamptz NOT NULL CHECK (isfinite(last_confirmed_at) AND last_confirmed_at >= observed_at),
  inventory_active boolean,
  status_active boolean,
  active boolean GENERATED ALWAYS AS (coalesce(status_active, inventory_active)) STORED,
  active_source text GENERATED ALWAYS AS (CASE WHEN status_active IS NOT NULL THEN 'status'
    WHEN inventory_active IS NOT NULL THEN 'inventory' ELSE 'unknown' END) STORED,
  working boolean,
  configured_to_record boolean,
  writing_to_disk boolean,
  status_coverage text NOT NULL CHECK (status_coverage IN ('unknown','matched','missing')),
  reason text NOT NULL CHECK (reason IN ('initial','state_changed','coverage_changed','resumed','binding_changed')),
  normalization_version integer NOT NULL CHECK (normalization_version > 0),
  UNIQUE (camera_id, state_sequence), UNIQUE (camera_id, server_run_id),
  FOREIGN KEY (camera_id, binding_id) REFERENCES camera_bindings(camera_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (server_id, server_run_id) REFERENCES sync_server_runs(server_id, id) ON DELETE RESTRICT,
  CHECK (status_coverage = 'matched' OR (status_active IS NULL AND working IS NULL AND configured_to_record IS NULL AND writing_to_disk IS NULL))
);
CREATE INDEX camera_changes_history_idx ON camera_state_changes(camera_id, observed_at DESC);
CREATE INDEX camera_changes_run_idx ON camera_state_changes(server_run_id);
CREATE INDEX camera_changes_binding_idx ON camera_state_changes(binding_id);

CREATE TABLE server_health_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id uuid NOT NULL,
  server_run_id uuid NOT NULL,
  health_sequence bigint NOT NULL CHECK (health_sequence > 0),
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  last_confirmed_at timestamptz NOT NULL CHECK (isfinite(last_confirmed_at) AND last_confirmed_at >= observed_at),
  transport_state text NOT NULL CHECK (transport_state IN ('unknown','responding','unreachable')),
  query_state text NOT NULL CHECK (query_state IN ('unknown','healthy','partial','auth_error','http_error','invalid_response','configuration_error','transport_error')),
  UNIQUE (server_id, health_sequence), UNIQUE (server_id, server_run_id), UNIQUE (server_id, id, health_sequence),
  FOREIGN KEY (server_id, server_run_id) REFERENCES sync_server_runs(server_id, id) ON DELETE RESTRICT,
  CHECK (query_state NOT IN ('healthy','auth_error','http_error','invalid_response') OR transport_state = 'responding'),
  CHECK (transport_state <> 'unreachable' OR query_state = 'transport_error')
);
CREATE INDEX server_health_history_idx ON server_health_changes(server_id, observed_at DESC);
CREATE INDEX server_health_run_idx ON server_health_changes(server_run_id);

-- The current health is a pointer, so flags cannot disagree with their history.
CREATE TABLE server_current_health (
  server_id uuid PRIMARY KEY REFERENCES digifort_servers(id) ON DELETE RESTRICT,
  health_change_id uuid NOT NULL,
  health_sequence bigint NOT NULL,
  last_attempt_at timestamptz NOT NULL CHECK (isfinite(last_attempt_at)),
  last_response_at timestamptz CHECK (isfinite(last_response_at) AND last_response_at <= last_attempt_at),
  last_success_at timestamptz CHECK (isfinite(last_success_at) AND last_success_at <= last_attempt_at),
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  FOREIGN KEY (server_id, health_change_id, health_sequence) REFERENCES server_health_changes(server_id, id, health_sequence) ON DELETE RESTRICT
);

CREATE FUNCTION guard_sync_control() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.issued_sequence < OLD.issued_sequence OR NEW.applied_sequence < OLD.applied_sequence
    OR (NEW.lease_token IS DISTINCT FROM OLD.lease_token AND NEW.lease_token IS NOT NULL AND NEW.issued_sequence <= OLD.issued_sequence) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Server sequence or fencing token cannot move backwards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_control_guard BEFORE UPDATE ON server_sync_control FOR EACH ROW EXECUTE FUNCTION guard_sync_control();

CREATE FUNCTION protect_sync_record() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Synchronization history cannot be deleted';
  END IF;
  IF TG_TABLE_NAME = 'sync_runs' OR TG_TABLE_NAME = 'sync_server_runs' THEN
    IF OLD.outcome <> 'running' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.started_at IS DISTINCT FROM OLD.started_at
      OR (TG_TABLE_NAME = 'sync_runs' AND (to_jsonb(NEW) - ARRAY['outcome','finished_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['outcome','finished_at']))
      OR (TG_TABLE_NAME = 'sync_server_runs' AND (to_jsonb(NEW) - ARRAY['outcome','finished_at','inventory_completeness','inventory_count','status_count','matched_count','missing_status_count','orphan_status_count','applied_at'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['outcome','finished_at','inventory_completeness','inventory_count','status_count','matched_count','missing_status_count','orphan_status_count','applied_at'])) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Terminal runs and execution identity are immutable';
    END IF;
  ELSIF TG_TABLE_NAME IN ('camera_state_changes','server_health_changes') THEN
    IF TG_TABLE_NAME = 'camera_state_changes' THEN
      PERFORM 1 FROM cameras WHERE id = OLD.camera_id FOR UPDATE;
      IF NEW.last_confirmed_at > OLD.last_confirmed_at AND EXISTS (
        SELECT 1 FROM camera_state_changes WHERE camera_id = OLD.camera_id AND state_sequence > OLD.state_sequence) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only the latest camera event can be confirmed';
      END IF;
    ELSE
      PERFORM 1 FROM digifort_servers WHERE id = OLD.server_id FOR UPDATE;
      IF NEW.last_confirmed_at > OLD.last_confirmed_at AND EXISTS (
        SELECT 1 FROM server_health_changes WHERE server_id = OLD.server_id AND health_sequence > OLD.health_sequence) THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Only the latest health event can be confirmed';
      END IF;
    END IF;
    IF (to_jsonb(NEW) - 'last_confirmed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'last_confirmed_at') OR NEW.last_confirmed_at < OLD.last_confirmed_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Observation history is immutable';
    END IF;
  ELSE
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Diagnostic history is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_run_guard BEFORE UPDATE OR DELETE ON sync_runs FOR EACH ROW EXECUTE FUNCTION protect_sync_record();
CREATE TRIGGER sync_server_run_guard BEFORE UPDATE OR DELETE ON sync_server_runs FOR EACH ROW EXECUTE FUNCTION protect_sync_record();
CREATE TRIGGER sync_attempt_guard BEFORE UPDATE OR DELETE ON sync_endpoint_attempts FOR EACH ROW EXECUTE FUNCTION protect_sync_record();
CREATE TRIGGER sync_issue_guard BEFORE UPDATE OR DELETE ON sync_issues FOR EACH ROW EXECUTE FUNCTION protect_sync_record();
CREATE TRIGGER camera_change_guard BEFORE UPDATE OR DELETE ON camera_state_changes FOR EACH ROW EXECUTE FUNCTION protect_sync_record();
CREATE TRIGGER health_change_guard BEFORE UPDATE OR DELETE ON server_health_changes FOR EACH ROW EXECUTE FUNCTION protect_sync_record();

CREATE FUNCTION validate_sync_observation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous record; execution sync_server_runs%ROWTYPE; link camera_bindings%ROWTYPE;
BEGIN
  SELECT * INTO execution FROM sync_server_runs WHERE id = NEW.server_run_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Observation requires an execution'; END IF;
  IF TG_TABLE_NAME = 'sync_issues' THEN
    IF NEW.binding_id IS NOT NULL THEN
      SELECT * INTO link FROM camera_bindings WHERE id = NEW.binding_id FOR SHARE;
      IF link.server_id IS DISTINCT FROM execution.server_id THEN
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Issue binding belongs to another server';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF execution.server_id IS DISTINCT FROM NEW.server_id OR NEW.observed_at < execution.started_at
    OR execution.finished_at IS NULL OR NEW.observed_at > execution.finished_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Observation must belong to a completed server execution';
  END IF;
  IF TG_TABLE_NAME = 'camera_state_changes' THEN
    PERFORM 1 FROM cameras WHERE id = NEW.camera_id FOR UPDATE;
    SELECT * INTO link FROM camera_bindings WHERE id = NEW.binding_id FOR SHARE;
    IF NOT FOUND OR link.server_id <> NEW.server_id OR link.camera_id <> NEW.camera_id THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Observation binding belongs to another camera or server';
    END IF;
    IF execution.applied_at IS NULL OR NEW.observed_at < link.valid_from OR (link.valid_to IS NOT NULL AND NEW.observed_at >= link.valid_to) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Camera observation requires an applied snapshot and a valid binding period';
    END IF;
    SELECT * INTO previous FROM camera_state_changes WHERE camera_id = NEW.camera_id ORDER BY state_sequence DESC LIMIT 1;
    IF FOUND AND (NEW.state_sequence <= previous.state_sequence OR NEW.observation_epoch < previous.observation_epoch OR NEW.observed_at < previous.last_confirmed_at
      OR (NEW.server_id = previous.server_id AND execution.sequence <= (SELECT sequence FROM sync_server_runs WHERE id = previous.server_run_id))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Camera history order cannot move backwards';
    END IF;
  ELSE
    PERFORM 1 FROM digifort_servers WHERE id = NEW.server_id FOR UPDATE;
    SELECT * INTO previous FROM server_health_changes WHERE server_id = NEW.server_id ORDER BY health_sequence DESC LIMIT 1;
    IF FOUND AND (NEW.health_sequence <= previous.health_sequence OR NEW.observed_at < previous.last_confirmed_at
      OR execution.sequence <= (SELECT sequence FROM sync_server_runs WHERE id = previous.server_run_id)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Server history order cannot move backwards';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_issue_binding_guard BEFORE INSERT ON sync_issues FOR EACH ROW EXECUTE FUNCTION validate_sync_observation();
CREATE TRIGGER camera_observation_guard BEFORE INSERT ON camera_state_changes FOR EACH ROW EXECUTE FUNCTION validate_sync_observation();
CREATE TRIGGER health_observation_guard BEFORE INSERT ON server_health_changes FOR EACH ROW EXECUTE FUNCTION validate_sync_observation();

CREATE FUNCTION guard_current_health() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Current health cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.server_id IS DISTINCT FROM OLD.server_id OR NEW.health_sequence < OLD.health_sequence OR NEW.last_attempt_at < OLD.last_attempt_at
    OR (OLD.last_response_at IS NOT NULL AND (NEW.last_response_at IS NULL OR NEW.last_response_at < OLD.last_response_at))
    OR (OLD.last_success_at IS NOT NULL AND (NEW.last_success_at IS NULL OR NEW.last_success_at < OLD.last_success_at))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Current health order cannot move backwards';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER current_health_guard BEFORE UPDATE OR DELETE ON server_current_health FOR EACH ROW EXECUTE FUNCTION guard_current_health();

-- The writer reserves a sequence/token and advances applied_sequence in the same
-- transaction that finalizes an applied run. Row locking fences competing writers.
CREATE FUNCTION validate_server_execution() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE control server_sync_control%ROWTYPE; revision bigint;
BEGIN
  SELECT * INTO control FROM server_sync_control WHERE server_id = NEW.server_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Server execution requires coordination state'; END IF;
  SELECT config_revision INTO revision FROM digifort_servers WHERE id = NEW.server_id FOR SHARE;
  IF NEW.config_revision <> revision OR NEW.sequence <> control.issued_sequence OR NEW.lease_token IS DISTINCT FROM control.lease_token
    OR control.lease_until IS NULL OR control.lease_until <= clock_timestamp() THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Stale server execution or expired lease';
  END IF;
  IF NEW.applied_at IS NOT NULL AND NEW.sequence <> control.applied_sequence THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Applied execution must match the committed server sequence';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER server_execution_insert_guard BEFORE INSERT ON sync_server_runs
  FOR EACH ROW EXECUTE FUNCTION validate_server_execution();
CREATE TRIGGER server_execution_update_guard BEFORE UPDATE ON sync_server_runs
  FOR EACH ROW WHEN (NEW.outcome = 'running' OR NEW.applied_at IS NOT NULL) EXECUTE FUNCTION validate_server_execution();

CREATE FUNCTION prevent_sync_control_delete() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Coordination sequences cannot be reset by deletion';
END $$;
CREATE TRIGGER sync_control_delete_guard BEFORE DELETE ON server_sync_control FOR EACH ROW EXECUTE FUNCTION prevent_sync_control_delete();

ALTER TABLE camera_state_changes ADD CONSTRAINT camera_changes_owner_id UNIQUE (camera_id, id);
ALTER TABLE camera_current_state ADD COLUMN last_state_change_id uuid;
ALTER TABLE camera_current_state ADD CONSTRAINT current_state_history_owner
  FOREIGN KEY (camera_id, last_state_change_id) REFERENCES camera_state_changes(camera_id, id) ON DELETE RESTRICT;
ALTER TABLE camera_inventory_versions ADD COLUMN source_server_run_id uuid REFERENCES sync_server_runs(id) ON DELETE RESTRICT;
CREATE INDEX inventory_source_run_idx ON camera_inventory_versions(source_server_run_id) WHERE source_server_run_id IS NOT NULL;

CREATE FUNCTION validate_inventory_provenance() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.source_server_run_id IS NOT NULL THEN
    PERFORM 1 FROM sync_server_runs r JOIN camera_bindings b ON b.server_id = r.server_id
      WHERE r.id = NEW.source_server_run_id AND b.id = NEW.binding_id AND r.applied_at IS NOT NULL FOR SHARE OF r, b;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Inventory provenance requires an applied execution of its binding server'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_provenance_guard BEFORE INSERT ON camera_inventory_versions FOR EACH ROW EXECUTE FUNCTION validate_inventory_provenance();

CREATE FUNCTION validate_endpoint_period() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE execution sync_server_runs%ROWTYPE;
BEGIN
  SELECT * INTO execution FROM sync_server_runs WHERE id = NEW.server_run_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Endpoint attempt requires an execution'; END IF;
  IF NEW.started_at < execution.started_at OR (execution.finished_at IS NOT NULL AND NEW.finished_at > execution.finished_at) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Endpoint attempt lies outside its execution';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER endpoint_period_guard BEFORE INSERT ON sync_endpoint_attempts FOR EACH ROW EXECUTE FUNCTION validate_endpoint_period();
