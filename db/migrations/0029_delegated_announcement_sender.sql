-- Existing requests and grants retain their original user sender.
ALTER TABLE slack_delivery_delegation_requests
  DROP CONSTRAINT slack_delivery_requests_execution_mode_check;
ALTER TABLE slack_delivery_delegation_requests
  ADD CONSTRAINT slack_delivery_requests_execution_mode_check
  CHECK (execution_mode IN ('user', 'bot'));

ALTER TABLE slack_delivery_grants
  ADD COLUMN execution_mode text NOT NULL DEFAULT 'user'
  CHECK (execution_mode IN ('user', 'bot'));
