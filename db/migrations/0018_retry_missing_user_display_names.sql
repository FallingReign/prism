UPDATE slack_connections
SET display_names_enriched_at = NULL,
    updated_at = now()
WHERE status = 'healthy'
  AND NULLIF(authed_user_display_name, '') IS NULL
  AND display_names_enriched_at IS NOT NULL;
