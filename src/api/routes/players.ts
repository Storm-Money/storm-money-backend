import { Router } from "express";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { clampLimit, clampOffset } from "../util.js";

export const playersRouter = Router();

// Per-player game summary -- the derived projection, not raw events.
// Scoped to config.contractId: an address could have a `games` row on a
// prior contract generation too (see 002_multi_contract_games_key.sql),
// and this endpoint should answer for the contract this service actually
// indexes, not whichever generation's row happens to match first.
playersRouter.get("/players/:address", async (req, res) => {
  const { address } = req.params;
  const { rows } = await pool.query("SELECT * FROM games WHERE player = $1 AND contract_id = $2", [
    address,
    config.contractId,
  ]);
  if (rows.length === 0) {
    res.status(404).json({ error: "no indexed activity for this address on the current contract" });
    return;
  }
  res.json({ game: rows[0] });
});

// Per-player raw event history, oldest first -- "read my whole game back
// from the event log", same promise the contract's own doc comment makes,
// just pre-decoded and paginated instead of requiring a client to call
// getEvents and decode XDR itself. Scoped to config.contractId for the
// same reason as above.
playersRouter.get("/players/:address/events", async (req, res) => {
  const { address } = req.params;
  const limit = clampLimit(req.query.limit, 100, 500);
  const offset = clampOffset(req.query.offset);
  const { rows } = await pool.query(
    `SELECT paging_token, ledger, ledger_closed_at, tx_hash, event_type, data
     FROM events
     WHERE player = $1 AND contract_id = $2
     ORDER BY paging_token ASC
     LIMIT $3 OFFSET $4`,
    [address, config.contractId, limit, offset],
  );
  res.json({ events: rows, limit, offset });
});
