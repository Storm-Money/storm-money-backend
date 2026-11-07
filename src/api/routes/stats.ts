import { Router } from "express";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";

export const statsRouter = Router();

interface AggregateRow {
  games_total: number;
  bankrupt_count: number;
  free_count: number;
  median_score: number | null;
}

// Field names and definitions deliberately mirror sim.py's solo_stats():
// bankrupt_rate = bankrupt / games, free_rate = reached_free / games,
// median_score = statistics.median(final_score) including the bankrupt
// sentinel in the sample -- same denominator (completed games only),
// same sentinel-inclusive median, so a number from here can be put next
// to a row of sim.py's solo_table() output and mean the same thing.
// Scoped to config.contractId -- the database can hold more than one
// contract generation's games (see 002_multi_contract_games_key.sql), and
// these stats must describe only the one this service is currently
// indexing, not every generation ever played.
statsRouter.get("/stats", async (_req, res) => {
  const { rows } = await pool.query<AggregateRow>(
    `SELECT
      count(*)::int AS games_total,
      count(*) FILTER (WHERE status = 'bankrupt')::int AS bankrupt_count,
      count(*) FILTER (WHERE free_round IS NOT NULL)::int AS free_count,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY final_score) AS median_score
    FROM games
    WHERE status IN ('finished', 'bankrupt') AND contract_id = $1`,
    [config.contractId],
  );
  const row = rows[0]!;

  const { rows: inProgressRows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM games WHERE status = 'in_progress' AND contract_id = $1`,
    [config.contractId],
  );

  res.json({
    games_total: row.games_total,
    games_in_progress: inProgressRows[0]!.count,
    bankrupt_rate: row.games_total > 0 ? row.bankrupt_count / row.games_total : null,
    free_rate: row.games_total > 0 ? row.free_count / row.games_total : null,
    median_score: row.median_score,
    comparable_to: "sim.py solo_stats() -- same denominator and sentinel handling",
  });
});
