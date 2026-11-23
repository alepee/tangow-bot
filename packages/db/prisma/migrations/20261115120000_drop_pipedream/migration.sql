-- Pipedream Connect was removed. Drop its saved credentials, connections, and
-- the apps shared bots declared through it.
DELETE FROM "integration_provider_configs" WHERE "id" = 'pipedream';
DELETE FROM "connections" WHERE "connectorId" = 'pipedream';
UPDATE "bots"
SET "connectors" = COALESCE(
  (
    SELECT jsonb_agg(entry ORDER BY position)
    FROM jsonb_array_elements("connectors") WITH ORDINALITY AS item(entry, position)
    WHERE entry->>'connectorId' IS DISTINCT FROM 'pipedream'
  ),
  '[]'::jsonb
)
WHERE "connectors" @> '[{"connectorId": "pipedream"}]'::jsonb;
