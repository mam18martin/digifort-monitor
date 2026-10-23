-- Requires the independently managed btree_gist extension.
CREATE TABLE nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text COLLATE "C" NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE camera_types (
  code text COLLATE "C" PRIMARY KEY CHECK (code ~ '^[A-Z]$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  enabled boolean NOT NULL DEFAULT true
);
INSERT INTO camera_types (code, name) VALUES ('D', 'Domo'), ('F', 'Fija'), ('P', 'Punto Seguro');

CREATE TABLE digifort_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text COLLATE "C" NOT NULL UNIQUE CHECK (btrim(config_key) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  endpoint_origin text NOT NULL CHECK (
    endpoint_origin ~ '^https?://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(:[0-9]{1,5})?$'
  ),
  credential_ref text CHECK (credential_ref ~ '^[A-Za-z0-9_-]+$'),
  enabled boolean NOT NULL DEFAULT false,
  config_revision bigint NOT NULL DEFAULT 1 CHECK (config_revision > 0),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cameras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_number text COLLATE "C",
  camera_type_code text COLLATE "C" REFERENCES camera_types(code) ON DELETE RESTRICT,
  camera_code text COLLATE "C" GENERATED ALWAYS AS (camera_number || camera_type_code) STORED,
  identity_review text NOT NULL DEFAULT 'provisional' CHECK (identity_review IN ('provisional', 'confirmed', 'disputed')),
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cameras_code_components CHECK (
    (camera_number IS NULL AND camera_type_code IS NULL)
    OR (camera_number IS NOT NULL AND camera_type_code IS NOT NULL AND camera_number ~ '^[0-9]+$')
  ),
  CONSTRAINT cameras_code_unique UNIQUE (camera_code)
);

CREATE TABLE camera_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  server_id uuid NOT NULL REFERENCES digifort_servers(id) ON DELETE RESTRICT,
  external_name text COLLATE "C" NOT NULL CHECK (btrim(external_name) <> ''),
  external_id text COLLATE "C" CHECK (btrim(external_id) <> ''),
  identity_generation integer NOT NULL DEFAULT 1 CHECK (identity_generation > 0),
  valid_from timestamptz NOT NULL DEFAULT now() CHECK (isfinite(valid_from)),
  valid_to timestamptz,
  reason text NOT NULL DEFAULT 'discovered' CHECK (reason IN ('discovered', 'renamed', 'moved', 'replaced', 'reconciled')),
  CONSTRAINT bindings_period CHECK (valid_to IS NULL OR (isfinite(valid_to) AND valid_to > valid_from)),
  UNIQUE (camera_id, id),
  UNIQUE (server_id, external_name, identity_generation),
  CONSTRAINT bindings_camera_overlap EXCLUDE USING gist
    (camera_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&),
  CONSTRAINT bindings_name_overlap EXCLUDE USING gist
    (server_id WITH =, external_name WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&),
  CONSTRAINT bindings_external_id_overlap EXCLUDE USING gist
    (server_id WITH =, external_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
    WHERE (external_id IS NOT NULL)
);
CREATE INDEX bindings_open_server_idx ON camera_bindings(server_id, camera_id) WHERE valid_to IS NULL;

CREATE TABLE camera_inventory_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id uuid NOT NULL REFERENCES cameras(id) ON DELETE RESTRICT,
  binding_id uuid NOT NULL,
  node_id uuid REFERENCES nodes(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL DEFAULT now() CHECK (isfinite(valid_from)),
  valid_to timestamptz,
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),
  origin text NOT NULL DEFAULT 'digifort' CHECK (origin IN ('digifort', 'manual', 'reconciliation')),
  description_original text,
  description_text text,
  description_redacted boolean NOT NULL DEFAULT false,
  code_candidate text,
  number_candidate text,
  type_code_candidate text,
  code_parse_status text NOT NULL DEFAULT 'absent' CHECK (code_parse_status IN ('absent', 'invalid', 'unknown_type', 'valid')),
  code_review_status text NOT NULL DEFAULT 'pending' CHECK (code_review_status IN ('pending', 'accepted', 'conflict', 'rejected')),
  code_parser_version text,
  model text,
  device_type text,
  connection_address text,
  connection_ip inet,
  connection_port integer CHECK (connection_port BETWEEN 1 AND 65535),
  latitude numeric CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric CHECK (longitude BETWEEN -180 AND 180),
  memo text,
  media_profiles jsonb,
  camera_group jsonb,
  source_scalars jsonb NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(source_scalars) = 'object'
    AND source_scalars - ARRAY['DeviceType','ConnectionPort','Latitude','Longitude'] = '{}'::jsonb
  ),
  CONSTRAINT inventory_binding_owner FOREIGN KEY (camera_id, binding_id)
    REFERENCES camera_bindings(camera_id, id) ON DELETE RESTRICT,
  CONSTRAINT inventory_period CHECK (valid_to IS NULL OR (isfinite(valid_to) AND valid_to > valid_from)),
  CONSTRAINT inventory_observation_times CHECK (
    isfinite(first_observed_at) AND isfinite(last_confirmed_at)
    AND first_observed_at >= valid_from AND last_confirmed_at >= first_observed_at
    AND (valid_to IS NULL OR last_confirmed_at <= valid_to)
  ),
  CONSTRAINT inventory_camera_overlap EXCLUDE USING gist
    (camera_id WITH =, tstzrange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX inventory_binding_idx ON camera_inventory_versions(binding_id);
CREATE INDEX inventory_open_node_idx ON camera_inventory_versions(node_id, camera_id) WHERE valid_to IS NULL;
CREATE INDEX inventory_camera_history_idx ON camera_inventory_versions(camera_id, valid_from DESC);

CREATE TABLE camera_current_state (
  camera_id uuid PRIMARY KEY REFERENCES cameras(id) ON DELETE RESTRICT,
  binding_id uuid,
  inventory_active boolean,
  status_active boolean,
  active boolean GENERATED ALWAYS AS (coalesce(status_active, inventory_active)) STORED,
  active_source text GENERATED ALWAYS AS (
    CASE WHEN status_active IS NOT NULL THEN 'status'
      WHEN inventory_active IS NOT NULL THEN 'inventory' ELSE 'unknown' END
  ) STORED,
  working boolean,
  configured_to_record boolean,
  writing_to_disk boolean,
  recording_source_scalars jsonb NOT NULL DEFAULT '{}' CHECK (
    jsonb_typeof(recording_source_scalars) = 'object'
    AND recording_source_scalars - ARRAY['ActiveTime','InactiveTime','RecordingFPS','RecordingHours','RecordingHoursEstimative','UsedDiskSpace'] = '{}'::jsonb
  ),
  last_attempt_at timestamptz,
  last_snapshot_success_at timestamptz,
  last_inventory_seen_at timestamptz,
  last_status_seen_at timestamptz,
  active_observed_at timestamptz,
  working_observed_at timestamptz,
  recording_observed_at timestamptz,
  inventory_presence text NOT NULL DEFAULT 'unknown' CHECK (inventory_presence IN ('unknown', 'present', 'missing', 'retired')),
  status_coverage text NOT NULL DEFAULT 'unknown' CHECK (status_coverage IN ('unknown', 'matched', 'missing')),
  missing_since timestamptz,
  consecutive_complete_inventory_misses integer NOT NULL DEFAULT 0 CHECK (consecutive_complete_inventory_misses >= 0),
  observation_epoch bigint NOT NULL DEFAULT 0 CHECK (observation_epoch >= 0),
  applied_sequence bigint NOT NULL DEFAULT 0 CHECK (applied_sequence >= 0),
  CONSTRAINT state_binding_owner FOREIGN KEY (camera_id, binding_id)
    REFERENCES camera_bindings(camera_id, id) ON DELETE RESTRICT,
  CONSTRAINT state_active_time CHECK ((active IS NULL) = (active_observed_at IS NULL)),
  CONSTRAINT state_working_time CHECK ((working IS NULL) = (working_observed_at IS NULL)),
  CONSTRAINT state_recording_time CHECK (
    (configured_to_record IS NULL AND writing_to_disk IS NULL) OR recording_observed_at IS NOT NULL
  ),
  CONSTRAINT state_status_coverage CHECK (
    status_coverage = 'matched' OR
    (status_active IS NULL AND working IS NULL AND configured_to_record IS NULL AND writing_to_disk IS NULL
      AND recording_source_scalars = '{}'::jsonb AND recording_observed_at IS NULL)
  ),
  CONSTRAINT state_detached_unknown CHECK (
    binding_id IS NOT NULL OR
    (inventory_active IS NULL AND status_active IS NULL AND working IS NULL
      AND configured_to_record IS NULL AND writing_to_disk IS NULL
      AND recording_source_scalars = '{}'::jsonb AND status_coverage = 'unknown')
  )
);
CREATE INDEX state_last_success_idx ON camera_current_state(last_snapshot_success_at);
CREATE INDEX state_binding_idx ON camera_current_state(binding_id);

-- Prevent deletion/reassignment instead of guessing a municipal correction policy.
CREATE FUNCTION protect_camera_identity() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Camera deletion is disabled; retire the camera';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR
    (OLD.camera_number IS NOT NULL AND
      (NEW.camera_number, NEW.camera_type_code) IS DISTINCT FROM (OLD.camera_number, OLD.camera_type_code)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Identity correction requires a future audited operation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER camera_identity_guard BEFORE UPDATE OR DELETE ON cameras
  FOR EACH ROW EXECUTE FUNCTION protect_camera_identity();

CREATE FUNCTION require_enabled_camera_type() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.camera_type_code IS NOT NULL AND
    (TG_OP = 'INSERT' OR NEW.camera_type_code IS DISTINCT FROM OLD.camera_type_code) THEN
    PERFORM 1 FROM camera_types WHERE code = NEW.camera_type_code AND enabled FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Camera type must exist and be enabled';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER camera_type_guard BEFORE INSERT OR UPDATE ON cameras
  FOR EACH ROW EXECUTE FUNCTION require_enabled_camera_type();

CREATE FUNCTION protect_binding_history() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Binding history cannot be deleted';
  END IF;
  IF (NEW.id, NEW.camera_id, NEW.server_id, NEW.external_name, NEW.external_id,
      NEW.identity_generation, NEW.valid_from, NEW.reason)
    IS DISTINCT FROM
    (OLD.id, OLD.camera_id, OLD.server_id, OLD.external_name, OLD.external_id,
      OLD.identity_generation, OLD.valid_from, OLD.reason)
    OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Binding identity and closed periods are immutable';
  END IF;
  IF NEW.valid_to IS NOT NULL THEN
    PERFORM 1 FROM camera_current_state WHERE binding_id = OLD.id;
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Detach current state before closing binding';
    END IF;
    PERFORM 1 FROM camera_inventory_versions WHERE binding_id = OLD.id
      AND (valid_to IS NULL OR valid_to > NEW.valid_to);
    IF FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Close inventory periods before closing binding';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER binding_history_guard BEFORE UPDATE OR DELETE ON camera_bindings
  FOR EACH ROW EXECUTE FUNCTION protect_binding_history();

CREATE FUNCTION protect_inventory_history() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE binding camera_bindings%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inventory history cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'valid_to' - 'last_confirmed_at') IS DISTINCT FROM
       (to_jsonb(OLD) - 'valid_to' - 'last_confirmed_at')
       OR (OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to)
       OR NEW.last_confirmed_at < OLD.last_confirmed_at THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inventory versions are immutable; append a version';
    END IF;
  END IF;
  SELECT * INTO binding FROM camera_bindings WHERE id = NEW.binding_id FOR SHARE;
  IF NOT FOUND OR binding.camera_id <> NEW.camera_id THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Inventory binding does not belong to camera';
  END IF;
  IF NOT (tstzrange(NEW.valid_from, NEW.valid_to, '[)') <@
          tstzrange(binding.valid_from, binding.valid_to, '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Inventory period must be inside binding period';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_history_guard BEFORE INSERT OR UPDATE OR DELETE ON camera_inventory_versions
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_history();

CREATE FUNCTION validate_current_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Current state cannot be deleted';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.camera_id IS DISTINCT FROM OLD.camera_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Current state identity cannot be reassigned';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.applied_sequence < OLD.applied_sequence OR NEW.observation_epoch < OLD.observation_epoch) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Observation sequence cannot move backwards';
  END IF;
  IF NEW.binding_id IS NOT NULL THEN
    PERFORM 1 FROM camera_bindings WHERE id = NEW.binding_id AND camera_id = NEW.camera_id
      AND valid_to IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'Current state requires an open binding of the camera';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER current_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON camera_current_state
  FOR EACH ROW EXECUTE FUNCTION validate_current_binding();

CREATE FUNCTION initialize_camera_state() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO camera_current_state(camera_id) VALUES (NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER camera_initial_state AFTER INSERT ON cameras
  FOR EACH ROW EXECUTE FUNCTION initialize_camera_state();
