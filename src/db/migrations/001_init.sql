-- Raw, append-only log of every decoded contract event. `paging_token` is
-- the Stellar RPC getEvents `id` field, which is globally and strictly
-- ordered across ledgers/tx/op within a contract -- it doubles as the
-- idempotency key (re-polling the same range is a safe no-op) and as the
-- pagination cursor.
CREATE TABLE IF NOT EXISTS events (
  paging_token      TEXT PRIMARY KEY,
  contract_id        TEXT NOT NULL,
  ledger             BIGINT NOT NULL,
  ledger_closed_at   TIMESTAMPTZ NOT NULL,
  tx_hash            TEXT NOT NULL,
  event_type         TEXT NOT NULL, -- 'round_resolved' | 'action_taken' | 'game_finished'
  player             TEXT NOT NULL,
  data               JSONB NOT NULL, -- decoded event body, native JS shape
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_player ON events (player);
CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (event_type);

-- One row per player. The contract only allows one lifetime game per
-- address (`join` errors with AlreadyJoined on a second call), so player
-- address is a safe 1:1 key for "a game" -- there is no separate game id.
--
-- NOTE on coverage: `take_loan`, `repay_loan`, and `buy_insurance` do not
-- publish contract events (see storm-economy/src/lib.rs). This projection,
-- and therefore the API, cannot see loan or insurance activity -- only
-- `get_state` (a direct contract read, not an event) can. That's a gap in
-- the contract's event log, not a bug in this indexer; it's called out in
-- the backend README and should stay visible rather than be papered over.
CREATE TABLE IF NOT EXISTS games (
  player             TEXT PRIMARY KEY,
  contract_id        TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | finished | bankrupt
  current_round      INT NOT NULL DEFAULT 0,
  free_round         INT,     -- round number that first hit the "Free" milestone
  bankrupt_round     INT,
  final_score        INT,
  final_cash         INT,
  stalls_bought      INT NOT NULL DEFAULT 0,
  businesses_bought  INT NOT NULL DEFAULT 0,
  side_hustles       INT NOT NULL DEFAULT 0,
  first_ledger       BIGINT NOT NULL,
  first_seen_at      TIMESTAMPTZ NOT NULL,
  last_ledger        BIGINT NOT NULL,
  last_event_at      TIMESTAMPTZ NOT NULL,
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_games_status ON games (status);
CREATE INDEX IF NOT EXISTS idx_games_final_score ON games (final_score);

-- Indexer progress, one row per contract we index (today: just one).
CREATE TABLE IF NOT EXISTS ingest_cursor (
  contract_id  TEXT PRIMARY KEY,
  cursor       TEXT,     -- last processed getEvents paging token
  last_ledger  BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leaderboard: best final scores first. Bankrupt games keep the contract's
-- own final_score sentinel (-999), which sorts them to the bottom without
-- any special-casing here.
CREATE OR REPLACE VIEW leaderboard AS
  SELECT
    player,
    final_score,
    final_cash,
    status,
    bankrupt_round,
    free_round,
    current_round,
    finished_at
  FROM games
  WHERE status IN ('finished', 'bankrupt')
  ORDER BY final_score DESC NULLS LAST, finished_at ASC;
