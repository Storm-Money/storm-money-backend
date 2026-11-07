-- A second contract generation now exists (storm-economy's persona
-- redeploy, see ../../../README.md) -- player address alone is no longer
-- a safe key for the `games` projection. If the same wallet ever joins
-- two different contract deployments, the old PK (player) would silently
-- merge a second generation's stats into the first generation's row via
-- ON CONFLICT (player) DO UPDATE. Widen the key to (player, contract_id)
-- so each generation gets its own row per player.
ALTER TABLE games DROP CONSTRAINT games_pkey;
ALTER TABLE games ADD PRIMARY KEY (player, contract_id);

-- Every app-level query that reads `games` or `leaderboard` must now also
-- filter by contract_id (scoped to config.contractId, the currently
-- indexed generation) -- see api/routes/*.ts. The view itself stays
-- generation-agnostic (exposes contract_id so callers can filter) rather
-- than baking "the current contract" into a view definition that would
-- go stale the next time this contract redeploys.
-- CREATE OR REPLACE VIEW can only append columns, not insert them, so
-- contract_id goes at the end to keep this a same-view replace rather
-- than a drop+recreate (which would need to re-grant privileges).
CREATE OR REPLACE VIEW leaderboard AS
  SELECT
    player,
    final_score,
    final_cash,
    status,
    bankrupt_round,
    free_round,
    current_round,
    finished_at,
    contract_id
  FROM games
  WHERE status IN ('finished', 'bankrupt')
  ORDER BY final_score DESC NULLS LAST, finished_at ASC;
