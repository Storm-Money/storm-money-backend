import { Router } from "express";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT cursor, last_ledger, updated_at FROM ingest_cursor WHERE contract_id = $1",
      [config.contractId],
    );
    res.json({
      status: "ok",
      db: "ok",
      contract_id: config.contractId,
      indexer: rows[0] ?? { note: "indexer has not completed a first poll cycle yet" },
    });
  } catch (err) {
    res.status(503).json({ status: "degraded", error: (err as Error).message });
  }
});
