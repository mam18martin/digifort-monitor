-- Explicit reverse dependency order. Never use CASCADE.
DROP TRIGGER camera_initial_state ON cameras;
DROP FUNCTION initialize_camera_state();
DROP TABLE camera_current_state;
DROP FUNCTION validate_current_binding();
DROP TABLE camera_inventory_versions;
DROP FUNCTION protect_inventory_history();
DROP TABLE camera_bindings;
DROP FUNCTION protect_binding_history();
DROP TABLE cameras;
DROP FUNCTION require_enabled_camera_type();
DROP FUNCTION protect_camera_identity();
DROP TABLE digifort_servers;
DROP TABLE camera_types;
DROP TABLE nodes;
