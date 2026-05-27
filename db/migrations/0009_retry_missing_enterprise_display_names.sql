UPDATE slack_connections
SET display_names_enriched_at = NULL,
    updated_at = now()
WHERE status = 'healthy'
  AND NULLIF(enterprise_id, '') IS NOT NULL
  AND NULLIF(enterprise_name, '') IS NULL;
