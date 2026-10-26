-- Application users and server administration only. No camera identities or prior migrations change.
CREATE TABLE app_users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 username text NOT NULL CHECK (username ~ '^[A-Za-z0-9_.-]{3,80}$'),
 password_hash text NOT NULL CHECK (password_hash ~ '^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
 role text NOT NULL CHECK (role IN ('admin','viewer')),
 enabled boolean NOT NULL DEFAULT true,
 auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX app_users_username_idx ON app_users(lower(username));
CREATE TABLE server_admin_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 server_id uuid NOT NULL REFERENCES digifort_servers(id) ON DELETE RESTRICT,
 operator_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 action text NOT NULL CHECK(action IN ('create','update','retire')),
 config_revision bigint NOT NULL CHECK(config_revision>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(server_id,config_revision)
);
CREATE FUNCTION validate_server_admin_update() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Use logical retirement'; END IF;
 IF NEW.config_revision<>OLD.config_revision+1 OR OLD.retired_at IS NOT NULL OR (NEW.retired_at IS NOT NULL AND NEW.enabled) THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Invalid server revision or retirement';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER server_admin_revision BEFORE UPDATE OR DELETE ON digifort_servers FOR EACH ROW EXECUTE FUNCTION validate_server_admin_update();

CREATE FUNCTION protect_server_admin_events() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Server audit is append-only'; END $$;
CREATE TRIGGER server_admin_event_guard BEFORE UPDATE OR DELETE ON server_admin_events FOR EACH ROW EXECUTE FUNCTION protect_server_admin_events();
