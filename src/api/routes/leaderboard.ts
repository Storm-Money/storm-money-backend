import { Router } from "express";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { clampLimit, clampOffset } from "../util.js";

export const leaderboardRouter = Router();

// Best final scores first. Bankrupt games carry the contract's own
// final_score sentinel (-999), so they fall to the bottom with no
// special-casing in this query -- see leaderboard view in
// db/migrations/001_init.sql. Scoped to config.contractId: the view
// itself is generation-agnostic (see 002_multi_contract_games_key.sql),
// so this route is what keeps a second contract generation's games out
// of the current one's leaderboard.
leaderboardRouter.get("/leaderboard", async (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 200);
  const offset = clampOffset(req.query.offset);
  const { rows } = await pool.query(
    `SELECT player, final_score, final_cash, status, bankrupt_round, free_round, current_round, finished_at
     FROM leaderboard
     WHERE contract_id = $1
     LIMIT $2 OFFSET $3`,
    [config.contractId, limit, offset],
  );
  res.json({ leaderboard: rows, limit, offset });
});
