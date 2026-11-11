# storm-money-backend

Event indexer + leaderboard API for the `storm-economy` Soroban contract
(`CBO4POPU3FQXXYE353LKO6KNHT2QJRZGOFDTQEKELS3H2ZZBNEPF3SOE`, Stellar
testnet). Fills the gap the chain side doesn't: nothing today answers
"who's played, what are the best scores, how many games finished" without
hand-querying RPC per address.

This is a solo-dev project. One service, one database, no microservices,
no queue, no separate worker process. That's a deliberate scope decision,
not a placeholder for "more later" -- see **Why this shape** below.

## What it does

1. **Indexer** (`src/indexer/`, `src/stellar/`): polls Stellar RPC's
   `getEvents` for the contract's three event types (`RoundResolved`,
   `ActionTaken`, `GameFinished`), decodes the XDR, and stores both the
   raw event log and a derived per-player projection.
2. **Database** (`src/db/`): Postgres. `events` is the append-only log;
   `games` is one row per player (derived); `leaderboard` is a view over
   `games`.
3. **API** (`src/api/`): a small read-only Express app serving the
   leaderboard, per-player history, and aggregate stats to the browser
   client (or anything else).

## Why this shape

**Language: TypeScript/Node, not Rust or Python.** The contract is Rust
and `sim.py` is Python, but neither is the right fit for *this* piece.
The browser client already talks to the contract through
`@stellar/stellar-sdk`'s JS build -- using the same SDK here means one
decode implementation to get right, not two (a Rust XDR decoder and a JS
one that have to agree). Node's ecosystem for "small indexer + REST API"
(Express, `pg`, cron-free polling loops) is also just more boring and
well-trodden for this shape of service than standing up an equivalent in
Rust or Python would be for a solo maintainer. `sim.py` stays Python and
untouched; this project mirrors its *stat definitions* (see Stats below),
not its language.

**Polling, not streaming -- and it's not a close call.** Stellar RPC's
`getEvents` is a paginated JSON-RPC method. There is no public
push/subscribe channel for Soroban contract events (unlike Horizon's SSE
streaming for classic payments/operations). The only way to get a push
feed is to run your own Core/captive-core ingestion pipeline, which is a
lot of permanent infrastructure for a contract that sees a handful of
transactions during an actual play session and zero the rest of the
time. Polling every 10s is already tighter than the game needs (the
browser client re-fetches `get_state` after every tx anyway) and is
nowhere near any RPC provider's rate limit for a single-contract filter.

**One service, not several.** Indexer and API share one Postgres
connection pool and one process (`src/index.ts` starts both). Splitting
them into separate deployables would mean two Railway services, two sets
of env vars, and a coordination problem (what if the API starts before
the indexer has ever run?) to solve a scaling problem this contract does
not have. If write volume ever genuinely outgrows one process, the first
move is a bigger Postgres plan and a longer poll interval, not a second
service.

## What the API cannot show you (a contract gap, not a bug here)

`take_loan`, `repay_loan`, and `buy_insurance` do **not** publish
contract events (see `storm-economy/src/lib.rs` -- only `roll_and_pay`
and `take_action` call `.publish(&env)`, and only on the paths that emit
`RoundResolved`/`ActionTaken`/`GameFinished`). That means loan and
insurance activity is invisible to this indexer and this API -- only a
direct `get_state` call against the contract can see it. The `games`
table's `stalls_bought` / `businesses_bought` / `side_hustles` counters
are accurate; there is no `loans_taken` counter because there is nothing
to count it from. If that coverage gap matters later, it's a contract
change (add events to those three calls), not a backend one.

## Decode layer: verified against the live contract, not guessed

`src/stellar/decode.ts` is pinned against **real events pulled from the
live testnet contract** on 2026-10-26 (see `test/fixtures/sample-events.json`
and `test/decode.test.ts`), not against an assumption about how
`#[contractevent]` serializes. Two things worth knowing if you touch this
layer:

- `rpc.Server#getEvents()` (the JS SDK call) returns already-parsed
  `xdr.ScVal` objects for `topic`/`value` and a `Contract` object for
  `contractId` -- *not* the base64 strings the raw JSON-RPC wire format
  uses. `src/stellar/rpc.ts` re-serializes those back to base64 XDR
  before handing them to `decode.ts`, so there is exactly one decode path
  to keep correct, and it's the one the unit tests exercise directly
  against captured wire-format fixtures.
- Event names arrive as snake_case symbols (`"round_resolved"`, not
  `"RoundResolved"`), and fieldless enum variants (`EventRoll`, `Action`)
  decode as one-element arrays (`["Emergency"]`), both confirmed live.

### Two real bugs this verification caught

Building this against actual testnet traffic (not just the Rust source)
surfaced two indexer bugs that would have silently stalled the whole
pipeline forever on a quiet contract -- exactly the failure mode that's
easy to miss if you only ever test against a dense, high-volume feed:

1. **The RPC's own `cursor` field advances even on a page with zero
   matching events.** This contract is quiet enough that most scan
   windows return no events. Deriving the next cursor from `events.at(-1)`
   (the obvious approach) means an empty page can't advance, so the
   indexer re-scans the same empty window forever. Fixed by always
   reading `cursor` from the response.
2. **The provider bounds each scan to a fixed ledger window (observed:
   ~10,000 ledgers) regardless of the requested `limit`.** A page
   "shorter than `limit`" does **not** mean "caught up to the tip" --
   confirmed live, a call starting ~111,000 ledgers before the chain tip
   returned 0 events and a cursor only ~10,000 ledgers further along.
   The poller now decodes the ledger number embedded in the cursor
   (`cursorLedger()` in `rpc.ts` -- the toid's high 32 bits) and keeps
   paging until that number reaches `latestLedger`, with a hard cap
   (`MAX_PAGES_PER_CYCLE`) as a safety net.

Both were caught by actually running the indexer against the live
contract end-to-end (migrations -> backfill -> API) before calling this
done, not by reasoning about the RPC spec in the abstract.

## Stats: comparable to `sim.py`'s regression gate

`GET /stats` deliberately mirrors the field definitions in `sim.py`'s
`solo_stats()`: `bankrupt_rate` and `free_rate` use the same denominator
(completed games only), and `median_score` includes the bankrupt sentinel
in the sample, same as `statistics.median(scores)` there. The intent is
that a number from this endpoint can sit next to a row of `sim.py`'s
`solo_table()` output and mean the same thing -- once there's enough real
on-chain play to compare against the simulated bot strategies. (Note:
the contract's bankrupt sentinel is `-999`; `sim.py`'s is `-100`. That
mismatch is pre-existing between the contract and the simulator, not
introduced here -- worth reconciling if a real side-by-side comparison
ever gets built, but out of scope for this backend to fix.)

## API

All responses are JSON. No auth -- this is a public read-only API over
public chain data, served to a static browser client, so a blanket CORS
allow is correct here, not a shortcut.

| Endpoint | Returns |
|---|---|
| `GET /health` | DB connectivity + indexer cursor/last-indexed-ledger |
| `GET /leaderboard?limit=&offset=` | Best `final_score` first (bankrupt games sort last automatically -- the contract's own `-999` sentinel does the work) |
| `GET /players/:address` | That player's derived game summary |
| `GET /players/:address/events?limit=&offset=` | That player's raw decoded event history, oldest first |
| `GET /stats` | `games_total`, `games_in_progress`, `bankrupt_rate`, `free_rate`, `median_score` |

## Database

`src/db/migrations/001_init.sql` (applied by `src/db/migrate.ts`, a
~40-line runner -- no migration framework dependency for one file):

- `events` -- append-only raw log, `paging_token` (the RPC's own
  globally-ordered event ID) as primary key and idempotency gate.
- `games` -- one row per player per contract generation (see
  `002_multi_contract_games_key.sql` below for why "per contract
  generation" was added after the fact).
- `ingest_cursor` -- indexer resume position.
- `leaderboard` -- a view over `games`.

Projection is idempotent by construction: `storeEventsPage()`
(`src/indexer/store.ts`) only applies an event to the `games` projection
when `INSERT ... ON CONFLICT (paging_token) DO NOTHING` actually inserted
a new row. Re-polling an already-seen range (which happens on every
restart) is a safe no-op -- verified by restarting the process against a
populated database and confirming event/game counts didn't move.

### `002_multi_contract_games_key.sql` -- a real bug this surfaced

The original schema keyed `games` on `player` alone, reasoning "the
contract only allows one lifetime game per address, so this is a safe
1:1 key." That reasoning assumed there would only ever be *one* contract.
It broke the moment a second generation was deployed (the persona
redeploy, see the top-level README): every app-level query (`/stats`,
`/leaderboard`, both `/players/:address` routes) read from `games` and
`leaderboard` with no `contract_id` filter at all, so a second
generation's rows would have silently shown up mixed into the first
generation's numbers -- and if the same wallet address ever joined both
generations, `ON CONFLICT (player) DO UPDATE` would have folded the
second game's event counts into the first game's row instead of giving
it a row of its own.

Caught before it caused visible corruption (no address in this project
happened to reuse itself across generations yet), but the latent bug was
real and would have fired silently the first time it did. Fixed by:
widening the `games` primary key to `(player, contract_id)`; scoping
every route (`stats.ts`, `leaderboard.ts`, both `players.ts` routes) to
`config.contractId`; and scoping every `UPDATE ... WHERE player = $1` in
`store.ts`'s projection logic to `WHERE player = $1 AND contract_id = $2`
instead. `health.ts` already filtered by `config.contractId` and needed
no change -- it was the one route that happened to get this right from
the start.

## Verification performed in this pass

Everything below was actually run, not just written:

- `npm test` -- 3 unit tests, decode logic pinned against real captured
  testnet event payloads. Passing.
- `npx tsc --noEmit` -- clean.
- Full local integration run: started a scratch Postgres database, ran
  migrations, started the service (indexer + API in one process) pointed
  at the **live deployed testnet contract**, let it backfill from the
  RPC's retention floor, and confirmed via `psql` and `curl` that:
  - 11 real events across 5 real player addresses were decoded and
    stored correctly (`action_taken` x6, `round_resolved` x5).
  - `/health`, `/leaderboard`, `/stats`, `/players/:address`, and
    `/players/:address/events` all returned correct, consistent data
    for that real on-chain state.
  - `/stats` correctly reported `games_total: 0` (no one has finished a
    game yet on this contract) with `bankrupt_rate`/`free_rate` as
    `null` rather than dividing by zero.
  - Restarting the process against the already-populated database
    resumed from the saved cursor with zero duplicate events or games.
  - A bogus unrecognized event is rejected with a clear error rather
    than silently indexed.

The scratch database and local `.env` used for this were torn down
afterward; nothing from that run is checked in.

## Running locally

```bash
npm install
cp .env.example .env   # edit DATABASE_URL to point at a local Postgres
npm run migrate        # idempotent; also runs automatically on `npm start`
npm run dev             # indexer + API, with auto-reload
```

Then:

```bash
curl localhost:8080/health
curl localhost:8080/leaderboard
curl localhost:8080/stats
```

Run the unit tests any time with `npm test` (no database or network
needed -- they run against fixed captured fixtures).

## Deployed on Railway

**Status: live** at
https://backend-production-fb315.up.railway.app (`/health`, `/leaderboard`,
`/stats`, `/players/:address`). The web client's leaderboard card reads
this domain.

Redeploying from this directory (needs a Railway project this account can
write to; a new project can hit the free plan's resource limit):

```bash
railway up
railway variable set DATABASE_URL='${{Postgres.DATABASE_URL}}'
railway variable set CONTRACT_ID=CBO4POPU3FQXXYE353LKO6KNHT2QJRZGOFDTQEKELS3H2ZZBNEPF3SOE
railway variable set RPC_URL=https://soroban-testnet.stellar.org
railway up
railway domain
```

Railway's Nixpacks builder auto-detects this as a Node project from
`package.json` and runs `npm install` then `npm start` -- no Dockerfile
or build config needed. `npm start` runs migrations before starting the
server (see `src/index.ts`), so a fresh deploy against an empty Postgres
creates its own schema; there's no separate "release command" step to
wire up.

The browser client points at that domain through `CONFIG.leaderboardApi`
in `web/app.js` (overridable with `?api=` for local development).

### TLS: one deliberate exception

`src/db/pool.ts` disables certificate *verification*
(`ssl: { rejectUnauthorized: false }`) for non-localhost
`DATABASE_URL`s. That is not a downgrade to plaintext — the connection
is still encrypted — but Railway's managed Postgres presents a
self-signed cert on its internal network, so there is no public CA to
verify against. Without it a fresh deploy crash-loops on every start
with `SELF_SIGNED_CERT_IN_CHAIN`, confirmed against the live service.
If this ever moves to a Postgres provider with a real CA, switch back to
`ssl: true` (or pin that provider's CA) rather than leaving this on.

## Project layout

```
src/
  config.ts              env vars
  db/
    pool.ts               pg Pool
    migrate.ts             tiny migration runner
    migrations/001_init.sql
  stellar/
    decode.ts              XDR -> typed event (unit tested against live fixtures)
    rpc.ts                 getEvents/getLatestLedger wrapper + the two bugs above
  indexer/
    store.ts                idempotent insert + games projection
    poller.ts               poll loop, cursor persistence, backfill
  api/
    server.ts                Express app, CORS, error handling
    util.ts                   pagination helpers
    routes/{health,leaderboard,players,stats}.ts
  index.ts                 entrypoint: migrate, start indexer loop, start API
test/
  decode.test.ts           pinned against real captured testnet payloads
  fixtures/sample-events.json
```
