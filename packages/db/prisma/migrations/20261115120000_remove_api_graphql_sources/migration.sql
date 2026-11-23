-- OpenAPI and GraphQL tool sources are removed. Drop the installs and the
-- encrypted credentials only they held.
WITH removed AS (
  DELETE FROM "capability_installs"
  WHERE "kind" IN ('api', 'graphql')
  RETURNING "secretId"
)
DELETE FROM "secrets" s
WHERE s."id" IN (SELECT "secretId" FROM removed WHERE "secretId" IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "capability_installs" ci
    WHERE ci."secretId" = s."id" AND ci."kind" NOT IN ('api', 'graphql')
  );
