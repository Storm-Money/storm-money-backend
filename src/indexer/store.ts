import type { PoolClient } from "pg";
import { pool } from "../db/pool.js";
import type { ActionTakenData, DecodedEvent, GameFinishedData, RoundResolvedData } from "../stellar/decode.js";

/**
 * Insert raw events (idempotent on paging_token) and fold each *newly*
 * inserted one into the `games` projection, in one transaction. Gating the
 * projection update on "was this row actually new" is what makes
 * re-polling an already-seen ledger range safe -- it will happen, since we
 * resume from a saved cursor that may be a few events behind the last
 * successful commit if the process died mid-page.
 *
 * Returns how many events were newly stored (for log noise control).
 */
export async function storeEventsPage(events: DecodedEvent[]): Promise<number> {
  if (events.length === 0) return 0;

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    for (const event of events) {
      if (await insertEventIfNew(client, event)) {
        await ensureGameRow(client, event);
        await applyToGameProjection(client, event);
        inserted++;
      }
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return inserted;
}

async function insertEventIfNew(client: PoolClient, event: DecodedEvent): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO events (paging_token, contract_id, ledger, ledger_closed_at, tx_hash, event_type, player, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (paging_token) DO NOTHING
     RETURNING paging_token`,
    [
      event.pagingToken,
      event.contractId,
      event.ledger,
      event.ledgerClosedAt,
      event.txHash,
      event.eventType,
      event.player,
      JSON.stringify(event.data),
    ],
  );
  return (res.rowCount ?? 0) > 0;
}

async function ensureGameRow(client: PoolClient, event: DecodedEvent): Promise<void> {
  await client.query(
    `INSERT INTO games (player, contract_id, first_ledger, first_seen_at, last_ledger, last_event_at)
     VALUES ($1, $2, $3, $4, $3, $4)
     ON CONFLICT (player, contract_id) DO UPDATE
       SET last_ledger = EXCLUDED.last_ledger, last_event_at = EXCLUDED.last_event_at
       WHERE games.last_ledger < EXCLUDED.last_ledger`,
    [event.player, event.contractId, event.ledger, event.ledgerClosedAt],
  );
}

// Every UPDATE below is scoped to (player, contract_id) -- not just
// player -- so a second contract generation can never fold its events
// into a first generation's row for the same address.
async function applyToGameProjection(client: PoolClient, event: DecodedEvent): Promise<void> {
  switch (event.eventType) {
    case "round_resolved": {
      const d = event.data as RoundResolvedData;
      await client.query(
        `UPDATE games SET
           current_round = GREATEST(current_round, $3),
           free_round = COALESCE(free_round, CASE WHEN $4 THEN $3 END),
           status = CASE WHEN $5 THEN 'bankrupt' ELSE status END,
           bankrupt_round = CASE WHEN $5 THEN $3 ELSE bankrupt_round END
         WHERE player = $1 AND contract_id = $2`,
        [event.player, event.contractId, d.round, d.hit_free_milestone, d.bankrupt],
      );
      return;
    }
    case "action_taken": {
      const d = event.data as ActionTakenData;
      await client.query(
        `UPDATE games SET
           current_round = GREATEST(current_round, $3),
           stalls_bought = stalls_bought + CASE WHEN $4 = 'BuyStall' THEN 1 ELSE 0 END,
           businesses_bought = businesses_bought + CASE WHEN $4 = 'BuyBusiness' THEN 1 ELSE 0 END,
           side_hustles = side_hustles + CASE WHEN $4 = 'SideHustle' THEN 1 ELSE 0 END
         WHERE player = $1 AND contract_id = $2`,
        [event.player, event.contractId, d.round, d.action],
      );
      return;
    }
    case "game_finished": {
      const d = event.data as GameFinishedData;
      await client.query(
        `UPDATE games SET
           status = CASE WHEN $3 THEN 'bankrupt' ELSE 'finished' END,
           final_score = $4,
           final_cash = $5,
           finished_at = $6
         WHERE player = $1 AND contract_id = $2`,
        [event.player, event.contractId, d.bankrupt, d.final_score, d.final_cash, event.ledgerClosedAt],
      );
      return;
    }
  }
}
