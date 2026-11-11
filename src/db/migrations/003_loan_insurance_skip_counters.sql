-- v3 of the contract publishes the events the first two generations were
-- missing (player_joined, loan_taken, loan_repaid, insurance_bought,
-- action_skipped). That turns the old "a contract gap, not a bug here"
-- note in 001_init.sql into something this indexer can finally count.
--
-- These are additive counters on the existing projection: no history is
-- recomputed, so a database that already indexed v2 simply starts at 0
-- for the actions v2 never reported. On the v3 contract they are exact.
ALTER TABLE games
  ADD COLUMN loans_taken     INT NOT NULL DEFAULT 0,
  ADD COLUMN loans_repaid    INT NOT NULL DEFAULT 0,
  ADD COLUMN insurance_bought BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN actions_skipped INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN games.actions_skipped IS
  'Planned actions inside v3 play_round that the round made unaffordable (error_code 8); logged on-chain, never silently dropped';
