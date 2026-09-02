ALTER TABLE prism_local_app_authorizations
  ADD COLUMN IF NOT EXISTS inbound_block_actions boolean NOT NULL DEFAULT false;
