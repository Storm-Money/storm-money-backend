import { Pool } from "pg";
import { config } from "../config.js";

// Singleton pool. This is a small indexer + read API for a low-volume indie
// contract -- a handful of concurrent players at most -- so the default
// pg pool size (10) is already generous, not a bottleneck to tune.
//
// TLS: enabled whenever we're not talking to a local dev Postgres. Railway's
// managed Postgres (and the public internet generally) should be reached
// over a verified TLS connection -- if you ever see a self-signed-cert
// error against a specific provider, fix it by trusting that provider's CA,
// not by disabling certificate verification here.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("localhost") ? false : true,
});

pool.on("error", (err) => {
  // Idle client errors (dropped connections) shouldn't crash the process;
  // the next query just gets a fresh client from the pool.
  console.error("[db] pool error", err);
});
