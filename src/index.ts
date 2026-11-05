import { createServer } from "./api/server.js";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { runIndexerLoop } from "./indexer/poller.js";

async function main(): Promise<void> {
  await runMigrations();
  console.log("[main] migrations up to date");

  const indexerAbort = new AbortController();
  const indexerDone = runIndexerLoop(indexerAbort.signal);

  const app = createServer();
  const server = app.listen(config.port, () => {
    console.log(`[main] API listening on :${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[main] received ${signal}, shutting down`);
    indexerAbort.abort();
    await indexerDone;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[main] fatal startup error:", err);
  process.exit(1);
});
