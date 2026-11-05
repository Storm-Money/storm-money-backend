import { Router } from "express";
import { pool } from "../../db/pool.js";
import { clampLimit, clampOffset } from "../util.js";

export const leaderboardRouter = Router();

// Best final scores first. Bankrupt games carry the contract's own
// final_score sentinel (-999), so they fall to the bottom with no
// special-casing in this query -- see leaderboard view in
// db/migrations/001_init.sql.
leaderboardRouter.get("/leaderboard", async (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 200);
  const offset = clampOffset(req.query.offset);
  const { rows } = await pool.query(
    `SELECT player, final_score, final_cash, status, bankrupt_round, free_round, current_round, finished_at
     FROM leaderboard
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  res.json({ leaderboard: rows, limit, offset });
});
