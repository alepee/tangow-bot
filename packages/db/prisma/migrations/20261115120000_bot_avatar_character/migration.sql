-- A bot is a clay character from the catalogue. Existing bots get one by creation order within
-- their owner and space, so each owner's first bots all differ. color and shapeSeed stay as they are.
ALTER TABLE "bots" ADD COLUMN "avatarCharacter" TEXT;

UPDATE "bots" AS b
SET "avatarCharacter" = (ARRAY['scout', 'atlas', 'ivy', 'saint-demon', 'sorciere', 'roi', 'mariachi', 'viking', 'monstre', 'toutankit', 'docteur-disquette'])[ranked.rank % 11 + 1]
FROM (
    SELECT id, (row_number() OVER (PARTITION BY "spaceId", "userId" ORDER BY "createdAt", id) - 1)::int AS rank
    FROM "bots"
) AS ranked
WHERE b.id = ranked.id;
