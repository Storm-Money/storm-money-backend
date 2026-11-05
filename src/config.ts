import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be an integer, got ${v}`);
  return n;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  contractId: required("CONTRACT_ID"),
  rpcUrl: process.env.RPC_URL ?? "https://soroban-testnet.stellar.org",
  pollIntervalMs: optionalInt("POLL_INTERVAL_MS", 10_000),
  pollPageLimit: optionalInt("POLL_PAGE_LIMIT", 200),
  port: optionalInt("PORT", 8080),
};
