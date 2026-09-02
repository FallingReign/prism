ALTER TABLE prism_slack_app_configuration_versions
  ADD COLUMN IF NOT EXISTS socket_mode_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS socket_api_app_id text,
  ADD COLUMN IF NOT EXISTS socket_app_token_envelope jsonb;

ALTER TABLE prism_slack_app_configuration_versions
  DROP CONSTRAINT IF EXISTS prism_slack_socket_configuration_complete;

ALTER TABLE prism_slack_app_configuration_versions
  ADD CONSTRAINT prism_slack_socket_configuration_complete CHECK (
    socket_mode_enabled = false
    OR (socket_api_app_id IS NOT NULL AND socket_app_token_envelope IS NOT NULL)
  );
