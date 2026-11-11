import { Pool } from "pg";
import { config } from "../config.js";

// Singleton pool. This is a small indexer + read API for a low-volume indie
// contract -- a handful of concurrent players at most -- so the default
// pg pool size (10) is already generous, not a bottleneck to tune.
//
// TLS: enabled whenever we're not talking to a local dev Postgres. Railway's
// managed Postgres presents a self-signed cert on its internal network --
// the connection is still encrypted, there's just no public CA to verify
// it against, so `rejectUnauthorized: false` is Railway's own documented
// fix (not a downgrade to plaintext). Confirmed live: without it, every
// query fails with `SELF_SIGNED_CERT_IN_CHAIN` against Railway's Postgres.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  // Idle client errors (dropped connections) shouldn't crash the process;
  // the next query just gets a fresh client from the pool.
  console.error("[db] pool error", err);
});
