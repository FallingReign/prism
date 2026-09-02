ALTER TABLE token_profiles DROP CONSTRAINT IF EXISTS token_profiles_preset_check;

ALTER TABLE token_profiles
  ADD CONSTRAINT token_profiles_preset_check
  CHECK (preset IN ('read_only', 'messages_only', 'full_slack_bridge', 'full_web_api', 'custom'));

UPDATE token_profiles
SET capability_map = jsonb_set(
  jsonb_set(
    jsonb_set(capability_map, '{version}', '2'::jsonb, true),
    '{webApi}',
    CASE
      WHEN preset = 'full_web_api' THEN '{"mode":"all_methods"}'::jsonb
      ELSE '{"mode":"curated"}'::jsonb
    END,
    true
  ),
  '{inbound}',
  COALESCE(capability_map->'inbound', '{"blockActions":false,"events":false,"slashCommands":false}'::jsonb),
  true
)
WHERE capability_map IS NOT NULL;
