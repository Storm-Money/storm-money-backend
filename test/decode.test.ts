import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEvent, type ActionTakenData, type RoundResolvedData, type RawRpcEvent } from "../src/stellar/decode.js";

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
