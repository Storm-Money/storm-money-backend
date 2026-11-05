// Polling, not streaming -- and that's the right call here, not a
// shortcut. Stellar RPC's getEvents is a paginated JSON-RPC method; there
// is no public push/subscribe channel for Soroban contract events (no
// websocket feed, unlike Horizon's SSE streaming for classic
// operations/payments). So "poll vs. stream" isn't actually a choice RPC
// offers for this data -- it's poll, or run your own Core/captive-core
// ingestion pipeline to get a push feed, which is a lot of permanent
// infrastructure for a contract that sees maybe a few dozen transactions
// an hour during an actual play session and zero the rest of the time.
// A 10s poll interval is already far tighter than this game needs (the
// browser client re-fetches state after every tx anyway) and comfortably
// inside any RPC provider's rate limit for a single contract filter.
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import {
  cursorLedger,
  fetchEventsFromLedger,
  fetchEventsSince,
  resolveOldestAvailableLedger,
  type EventsPage,
} from "../stellar/rpc.js";
import { storeEventsPage } from "./store.js";

// Hard ceiling on pages drained per poll cycle. The RPC's own ~10,000
// ledger scan window per call (see stellar/rpc.ts) means a cold-start
// backfill across a multi-day retention window takes on the order of a
// few dozen pages, not thousands -- this cap is a safety net against a
// misbehaving provider that never reports cursorLedger catching up to
// latestLedger, not a number we expect to hit in normal operation.
const MAX_PAGES_PER_CYCLE = 500;

interface CursorRow {
  cursor: string | null;
  last_ledger: number | null;
}

async function loadCursor(): Promise<CursorRow | null> {
  const { rows } = await pool.query<CursorRow>(
    "SELECT cursor, last_ledger FROM ingest_cursor WHERE contract_id = $1",
    [config.contractId],
  );
  return rows[0] ?? null;
}

async function saveCursor(cursor: string, lastLedger: number): Promise<void> {
  await pool.query(
    `INSERT INTO ingest_cursor (contract_id, cursor, last_ledger, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (contract_id) DO UPDATE SET cursor = $2, last_ledger = $3, updated_at = now()`,
    [config.contractId, cursor, lastLedger],
  );
}

/** One poll cycle: resume from the saved cursor (or bootstrap from the
 * oldest ledger the RPC node still retains), then drain pages by cursor
 * until we've actually caught up to the chain tip -- not until a page
 * merely looks "short", which (see stellar/rpc.ts) does not mean caught
 * up on this RPC provider. A cold-start backfill can legitimately span
 * dozens of pages; steady state is usually one near-empty page. */
async function pollOnce(): Promise<{ stored: number; cursor: string }> {
  const saved = await loadCursor();

  let page: EventsPage = saved?.cursor
    ? await fetchEventsSince(saved.cursor)
    : await fetchEventsFromLedger(await resolveOldestAvailableLedger());

  let totalStored = 0;
  let pages = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    pages++;
    totalStored += await storeEventsPage(page.events);
    // Persist the cursor every page, even an empty one: the RPC node's
    // cursor advances regardless of whether anything matched (see the
    // note in stellar/rpc.ts), and this is how a sparse contract's
    // backfill makes forward progress instead of rescanning the same
    // window on every cycle. We store the ledger the cursor actually
    // reached, not `latestLedger` (the chain tip) -- the two are only
    // equal once indexing is fully caught up.
    await saveCursor(page.cursor, cursorLedger(page.cursor));

    if (cursorLedger(page.cursor) >= page.latestLedger) break; // genuinely caught up
    if (pages >= MAX_PAGES_PER_CYCLE) {
      console.warn(
        `[indexer] hit MAX_PAGES_PER_CYCLE (${MAX_PAGES_PER_CYCLE}) before catching up to the tip; ` +
          "will continue next cycle. If this repeats, the RPC provider's scan window may have changed.",
      );
      break;
    }
    page = await fetchEventsSince(page.cursor);
  }

  if (pages > 1) {
    console.log(`[indexer] backfill: drained ${pages} pages, now at ledger ${cursorLedger(page.cursor)}`);
  }

  return { stored: totalStored, cursor: page.cursor };
}

export async function runIndexerLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const { stored, cursor } = await pollOnce();
      if (stored > 0) {
        console.log(`[indexer] stored ${stored} new event(s), cursor=${cursor}`);
      }
    } catch (err) {
      console.error("[indexer] poll cycle failed:", err);
    }
    await sleep(config.pollIntervalMs, signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
