import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  decodeEvent,
  type ActionSkippedData,
  type ActionTakenData,
  type LoanData,
  type PlayerJoinedData,
  type RoundResolvedData,
  type RawRpcEvent,
} from "../src/stellar/decode.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// These fixtures are the exact, unmodified getEvents response for two real
// transactions against the live testnet contract
// (CABDVHFVUJSNTWLHYWWSOWKIZS6OYFOSRLQNXPXI2OICFSHZCNMG4RAT), captured
// 2026-10-26. This test pins decode.ts against ground truth, not against
// an assumption about soroban-sdk's XDR encoding.
async function loadFixtures(): Promise<RawRpcEvent[]> {
  const raw = await readFile(path.join(__dirname, "fixtures", "sample-events.json"), "utf8");
  return JSON.parse(raw) as RawRpcEvent[];
}

test("decodes a RoundResolved event emitted by roll_and_pay", async () => {
  const [roundResolved] = await loadFixtures();
  const decoded = decodeEvent(roundResolved!);

  assert.equal(decoded.eventType, "round_resolved");
  assert.equal(decoded.player, "GAZ7DF5KNU24LBYVK3TA6HTNEKKMTE5W3ZBPE65OA7O2SQ2ZSMFNO7FT");
  assert.equal(decoded.ledger, 5404310);
  assert.equal(decoded.pagingToken, "0023211334707474432-0000000000");

  const data = decoded.data as RoundResolvedData;
  assert.equal(data.round, 1);
  assert.equal(data.roll, "Emergency");
  assert.equal(data.cash_after_payday, 1);
  assert.equal(data.bankrupt, false);
  assert.equal(data.hit_free_milestone, false);
});

test("decodes an ActionTaken event emitted by take_action", async () => {
  const [, actionTaken] = await loadFixtures();
  const decoded = decodeEvent(actionTaken!);

  assert.equal(decoded.eventType, "action_taken");
  assert.equal(decoded.player, "GAZ7DF5KNU24LBYVK3TA6HTNEKKMTE5W3ZBPE65OA7O2SQ2ZSMFNO7FT");

  const data = decoded.data as ActionTakenData;
  assert.equal(data.round, 1);
  assert.equal(data.action, "SideHustle");
  assert.equal(data.cash_after, 4);
});

test("rejects an event with an unrecognized topic[0]", () => {
  const bogus: RawRpcEvent = {
    id: "0000000000000000000-0000000000",
    contractId: "CABDVHFVUJSNTWLHYWWSOWKIZS6OYFOSRLQNXPXI2OICFSHZCNMG4RAT",
    ledger: 1,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    txHash: "deadbeef",
    // Verified XDR (generated with xdr.ScVal.scvSymbol("hello").toXDR("base64")):
    // the Symbol "hello" -- not a known event name.
    topic: ["AAAADwAAAAVoZWxsbwAAAA==", "AAAAEgAAAAAAAAAAM/GXqm01xYcVVuYPHm0ilMmTtt5C8nuuB92pQ1mTCtc="],
    // Verified XDR for ScVal::Void (xdr.ScVal.scvVoid().toXDR("base64")).
    value: "AAAAAQ==",
  };
  assert.throws(() => decodeEvent(bogus), /unrecognized topic/);
});

// v3 fixtures: the exact getEvents response for the v3 testnet deployment
// (CDRJL2JJEFNL6DZSA5HROPVSOIMLUI2374ZZSY7LATLG5YM7DBH4BUJ5), captured
// 2026-11-11 after a real join + one-tx round + skip + loan.
async function loadV3Fixtures(): Promise<RawRpcEvent[]> {
  const raw = await readFile(path.join(__dirname, "fixtures", "v3-events.json"), "utf8");
  return JSON.parse(raw) as RawRpcEvent[];
}

test("decodes v3's PlayerJoined (the event v2 never emitted)", async () => {
  const events = (await loadV3Fixtures()).map(decodeEvent);
  const joined = events.filter((e) => e.eventType === "player_joined");
  assert.equal(joined.length, 2);

  const data = joined[0]!.data as PlayerJoinedData;
  assert.equal(data.persona, "Hustler");
  assert.equal(data.starting_cash, 10);
});

test("decodes every event from a one-transaction round", async () => {
  const events = (await loadV3Fixtures()).map(decodeEvent);
  const round = events.find((e) => e.eventType === "round_resolved");
  assert.ok(round);

  const actions = events.filter((e) => e.eventType === "action_taken");
  assert.equal(actions.length, 2);
  assert.deepEqual(
    actions.map((a) => (a.data as ActionTakenData).action),
    ["SideHustle", "SideHustle"],
  );
  assert.deepEqual(
    actions.map((a) => (a.data as ActionTakenData).cash_after),
    [18, 23],
  );
});

test("decodes v3's ActionSkipped instead of dropping the event", async () => {
  const events = (await loadV3Fixtures()).map(decodeEvent);
  const skipped = events.filter((e) => e.eventType === "action_skipped");
  assert.equal(skipped.length, 1);

  const data = skipped[0]!.data as ActionSkippedData;
  assert.equal(data.round, 1);
  assert.equal(data.action, "BuyBusiness");
  assert.equal(data.error_code, 8); // Error::CantAfford
});

test("decodes v3's LoanTaken", async () => {
  const events = (await loadV3Fixtures()).map(decodeEvent);
  const loan = events.find((e) => e.eventType === "loan_taken");
  assert.ok(loan);

  const data = loan.data as LoanData;
  assert.equal(data.round, 1);
  assert.equal(data.loans, 1);
  assert.equal(data.cash_after, 23);
});
