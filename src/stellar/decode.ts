// Decoding is pinned against REAL events pulled from the live testnet
// contract (CABDVHFVUJSNTWLHYWWSOWKIZS6OYFOSRLQNXPXI2OICFSHZCNMG4RAT) on
// 2026-10-26, not guessed from the Rust source. See test/decode.test.ts for
// the exact captured payloads this was verified against.
//
// Confirmed shape, via `scValToNative`:
//   topic[0]  -> event name as a snake_case string, e.g. "round_resolved"
//                (soroban-sdk's #[contractevent] snake_cases the struct name)
//   topic[1]  -> the #[topic] Address field, decodes straight to a "G..."
//                string
//   value     -> a plain JS object keyed by field name for every non-topic
//                field. Fieldless enum variants (EventRoll, Action) decode
//                as a one-element array, e.g. roll: ["Emergency"].
//
// v3 added five topics (player_joined, loan_taken, loan_repaid,
// insurance_bought, action_skipped). Those are pinned against real events
// from the v3 testnet deployment in test/fixtures/v3-events.json; the
// original three keep the original captured fixtures.
import { xdr, scValToNative } from "@stellar/stellar-sdk";

export type EventType =
  | "round_resolved"
  | "action_taken"
  | "game_finished"
  | "player_joined"
  | "loan_taken"
  | "loan_repaid"
  | "insurance_bought"
  | "action_skipped";

export interface RoundResolvedData {
  round: number;
  roll: string; // EventRoll variant tag: MarketDip | Emergency | Calm | Storm
  cash_after_payday: number;
  bankrupt: boolean;
  hit_free_milestone: boolean;
}

export interface ActionTakenData {
  round: number;
  action: string; // Action variant tag: BuyStall | BuyBusiness | SideHustle
  cash_after: number;
}

export interface GameFinishedData {
  final_score: number;
  final_cash: number;
  bankrupt: boolean;
}

export interface PlayerJoinedData {
  persona: string; // Persona variant tag: Classic | Hustler | Saver | Builder | Gambler
  starting_cash: number;
}

/** Shared by loan_taken and loan_repaid. */
export interface LoanData {
  round: number;
  loans: number; // outstanding loans after this call
  cash_after: number;
}

export interface InsuranceBoughtData {
  round: number;
}

/** A planned action inside v3's play_round that the round's result made
 * impossible. error_code 8 is CantAfford, the one seen in practice. */
export interface ActionSkippedData {
  round: number;
  action: string;
  error_code: number;
}

export type DecodedData =
  | RoundResolvedData
  | ActionTakenData
  | GameFinishedData
  | PlayerJoinedData
  | LoanData
  | InsuranceBoughtData
  | ActionSkippedData;

export interface DecodedEvent {
  pagingToken: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: Date;
  txHash: string;
  eventType: EventType;
  player: string;
  data: DecodedData;
}

// Minimal shape of what rpc.Server#getEvents() returns per event -- we
// don't import the SDK's own type here to keep this module easy to unit
// test against a plain JSON fixture (see test/fixtures).
export interface RawRpcEvent {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: string[]; // base64 XDR ScVal
  value: string; // base64 XDR ScVal
}

const KNOWN_EVENT_TYPES = new Set<EventType>([
  "round_resolved",
  "action_taken",
  "game_finished",
  "player_joined",
  "loan_taken",
  "loan_repaid",
  "insurance_bought",
  "action_skipped",
]);

function unwrapEnum(v: unknown): string {
  // soroban-sdk fieldless enum variants arrive as a 1-element array:
  // scValToNative(Action::SideHustle) === ["SideHustle"]
  if (Array.isArray(v) && v.length >= 1 && typeof v[0] === "string") return v[0];
  if (typeof v === "string") return v;
  throw new Error(`Expected an enum-shaped value, got ${JSON.stringify(v)}`);
}

function decodeBody(eventType: EventType, body: any): DecodedData {
  switch (eventType) {
    case "round_resolved":
      return {
        round: body.round,
        roll: unwrapEnum(body.roll),
        cash_after_payday: body.cash_after_payday,
        bankrupt: body.bankrupt,
        hit_free_milestone: body.hit_free_milestone,
      };
    case "action_taken":
      return { round: body.round, action: unwrapEnum(body.action), cash_after: body.cash_after };
    case "game_finished":
      return { final_score: body.final_score, final_cash: body.final_cash, bankrupt: body.bankrupt };
    case "player_joined":
      return { persona: unwrapEnum(body.persona), starting_cash: body.starting_cash };
    case "loan_taken":
    case "loan_repaid":
      return { round: body.round, loans: body.loans, cash_after: body.cash_after };
    case "insurance_bought":
      return { round: body.round };
    case "action_skipped":
      return { round: body.round, action: unwrapEnum(body.action), error_code: body.error_code };
  }
}

/** Decode one raw getEvents entry into a typed, DB-ready record. Throws on
 * anything that doesn't match the pinned shape above -- better to skip a
 * malformed event loudly (and alert) than to silently index garbage. */
export function decodeEvent(raw: RawRpcEvent): DecodedEvent {
  if (raw.topic.length < 2) {
    throw new Error(`Event ${raw.id} has ${raw.topic.length} topics, expected at least 2`);
  }

  const eventName = scValToNative(xdr.ScVal.fromXDR(raw.topic[0]!, "base64"));
  const player = scValToNative(xdr.ScVal.fromXDR(raw.topic[1]!, "base64"));
  const body = scValToNative(xdr.ScVal.fromXDR(raw.value, "base64"));

  if (typeof eventName !== "string" || !KNOWN_EVENT_TYPES.has(eventName as EventType)) {
    throw new Error(`Event ${raw.id} has unrecognized topic[0]: ${JSON.stringify(eventName)}`);
  }
  if (typeof player !== "string") {
    throw new Error(`Event ${raw.id} has non-address topic[1]: ${JSON.stringify(player)}`);
  }

  const eventType = eventName as EventType;
  const data = decodeBody(eventType, body);

  return {
    pagingToken: raw.id,
    contractId: raw.contractId,
    ledger: raw.ledger,
    ledgerClosedAt: new Date(raw.ledgerClosedAt),
    txHash: raw.txHash,
    eventType,
    player,
    data,
  };
}
