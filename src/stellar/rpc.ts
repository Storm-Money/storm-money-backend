// Thin wrapper around @stellar/stellar-sdk's rpc.Server, scoped to the two
// calls the indexer needs. Verified live against testnet (2026-10-26):
// `new rpc.Server(url).getEvents({ filters, startLedger | cursor, limit })`
// and `.getLatestLedger()` both work exactly as the SDK docs describe, and
// getEvents accepts `cursor` in place of `startLedger` for subsequent
// pages (confirmed: a page fetched by cursor picks up strictly after that
// cursor, same exclusive semantics as Horizon paging tokens).
//
// IMPORTANT, found by actually running this against testnet rather than
// trusting the docs: the response's `cursor` field advances even when
// `events` comes back empty (a valid, error-free getEvents call for this
// low-volume contract routinely returns 0 events because most of the
// ledger range has none -- confirmed live: a real response had
// `events: []` alongside a fresh, different `cursor`). The cursor must be
// read from the RESPONSE, never derived from the last element of the
// events array -- deriving it from the last event means an empty page
// (the common case for a quiet contract) can't advance, and the poller
// re-scans the same empty window forever instead of walking forward.
//
// SECOND finding from the same live run: this provider also bounds each
// scan to a fixed ledger window regardless of `limit` (observed: a call
// from ledger ~5,293,500 advanced the cursor to ~5,303,499 -- a ~10,000
// ledger window -- and returned 0 events, well short of both `limit` and
// the chain tip). So "page.events.length < limit" is NOT a valid "we've
// reached the tip" signal on its own, and a cold-start backfill across a
// multi-day retention window needs several dozen such calls, not one or
// two. The poller must keep paging by cursor until cursorLedger(cursor)
// reaches latestLedger, independent of how many events each page held.
import { rpc } from "@stellar/stellar-sdk";
import { config } from "../config.js";
import { decodeEvent, type DecodedEvent, type RawRpcEvent } from "./decode.js";

const server = new rpc.Server(config.rpcUrl);

export interface EventsPage {
  events: DecodedEvent[];
  /** Raw event count from the RPC response, before any decode failures are
   * dropped. Use this (not events.length) to decide whether a page was
   * "full" and another page is likely waiting -- a dropped malformed event
   * must not look like end-of-data. */
  rawCount: number;
  /** Always present -- the RPC node's own continuation token for this
   * scan, whether or not any events matched. Persist it after every page,
   * empty or not, so the next poll resumes past the scanned range instead
   * of rescanning it. */
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
}

export async function getLatestLedger(): Promise<number> {
  const res = await server.getLatestLedger();
  return res.sequence;
}

/** The ledger sequence embedded in a getEvents cursor ("toid"). Confirmed
 * live: cursor "0023211334707474432-0000000000" was returned for an event
 * at ledger 5404310, and 23211334707474432 >> 32 === 5404310. This is the
 * only reliable way to tell how far a scan has actually progressed --
 * see the "bounded scan window" note below for why rawCount/limit isn't
 * enough. */
export function cursorLedger(cursor: string): number {
  const high = cursor.split("-")[0]!;
  return Number(BigInt(high) >> 32n);
}

type PagePosition = { kind: "cursor"; cursor: string } | { kind: "ledger"; startLedger: number };

async function fetchPage(position: PagePosition): Promise<EventsPage> {
  const filters = [{ type: "contract" as const, contractIds: [config.contractId] }];
  const res =
    position.kind === "cursor"
      ? await server.getEvents({ filters, limit: config.pollPageLimit, cursor: position.cursor })
      : await server.getEvents({ filters, limit: config.pollPageLimit, startLedger: position.startLedger });

  const events: DecodedEvent[] = [];
  for (const sdkEvent of res.events) {
    // rpc.Server#getEvents() hands back already-parsed xdr.ScVal objects
    // for topic/value (not base64 strings) and a Contract object for
    // contractId (not a "C..." string) -- confirmed live, and different
    // from the raw JSON-RPC wire format. Re-serialize to the same
    // base64-XDR shape decode.ts is pinned against (and that the raw
    // JSON-RPC protocol actually uses), so there's exactly one decode
    // path to keep correct and test.
    const raw: RawRpcEvent = {
      id: sdkEvent.id,
      // Always present for a "contract" filter match, but we already know
      // it -- we filtered on this exact contract ID -- so fall back
      // rather than fight the SDK's optional typing here.
      contractId: sdkEvent.contractId?.toString() ?? config.contractId,
      ledger: sdkEvent.ledger,
      ledgerClosedAt: sdkEvent.ledgerClosedAt,
      txHash: sdkEvent.txHash,
      topic: sdkEvent.topic.map((t) => t.toXDR("base64")),
      value: sdkEvent.value.toXDR("base64"),
    };
    try {
      events.push(decodeEvent(raw));
    } catch (err) {
      // One malformed/unexpected event shouldn't take down the whole
      // indexer -- log it loudly and keep going. If this ever fires in
      // practice it means the contract shipped a new event shape and
      // decode.ts needs updating.
      console.error(`[rpc] failed to decode event ${raw.id}:`, err);
    }
  }

  return {
    events,
    rawCount: res.events.length,
    cursor: res.cursor,
    latestLedger: res.latestLedger,
    oldestLedger: res.oldestLedger,
  };
}

export function fetchEventsSince(cursor: string): Promise<EventsPage> {
  return fetchPage({ kind: "cursor", cursor });
}

export function fetchEventsFromLedger(startLedger: number): Promise<EventsPage> {
  return fetchPage({ kind: "ledger", startLedger });
}

/** The oldest ledger this RPC node still retains events for. Used on cold
 * start (no saved cursor) to backfill as far back as the node allows,
 * instead of guessing a retention window constant. The `limit: 1` probe
 * call costs nothing extra -- `oldestLedger` comes back on every
 * getEvents response, successful or not. */
export async function resolveOldestAvailableLedger(): Promise<number> {
  const latest = await getLatestLedger();
  const probe = await fetchPage({ kind: "ledger", startLedger: Math.max(2, latest - 1) });
  return probe.oldestLedger;
}
