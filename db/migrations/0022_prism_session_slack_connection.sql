ALTER TABLE prism_sessions
  ADD COLUMN IF NOT EXISTS slack_connection_id text;

WITH ranked AS (
  SELECT
    s.session_token_hash,
    c.id AS slack_connection_id,
    row_number() OVER (
      PARTITION BY s.session_token_hash
      ORDER BY c.updated_at DESC, c.created_at DESC, c.id DESC
    ) AS rank
  FROM prism_sessions s
  JOIN slack_connections c ON c.prism_user_id = s.prism_user_id
  WHERE s.slack_connection_id IS NULL
)
UPDATE prism_sessions s
SET slack_connection_id = ranked.slack_connection_id
FROM ranked
WHERE ranked.rank = 1
  AND s.session_token_hash = ranked.session_token_hash;

-- A legacy website session cannot be made safe when its owning Slack
-- connection has already been removed. Invalidate it rather than allowing an
-- unbound session to survive or causing this migration to fail.
DELETE FROM prism_sessions
WHERE slack_connection_id IS NULL;

ALTER TABLE prism_sessions
  ALTER COLUMN slack_connection_id SET NOT NULL;

-- 0015 already provides the non-partial unique
-- slack_connections_id_owner_idx on (id, prism_user_id).
ALTER TABLE prism_sessions
  ADD CONSTRAINT prism_sessions_slack_connection_owner_fkey
  FOREIGN KEY (slack_connection_id, prism_user_id)
  REFERENCES slack_connections(id, prism_user_id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS prism_sessions_slack_connection_idx
  ON prism_sessions (slack_connection_id);
