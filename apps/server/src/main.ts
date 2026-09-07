import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { loadDefaultReplayFixture } from "./fixture.js";
import { discoverCoinbaseSlpProduct } from "./live/coordinator.js";
import { MemoryDecisionJournal, PostgresDecisionJournal } from "./paper/journal.js";
import { MemoryStrategyJournal, PostgresStrategyJournal } from "./strategy/journal.js";

const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
for (const fileName of [".env.preflight.local", ".env.live.local"]) {
  const path = resolve(invocationDirectory, fileName);
  if (existsSync(path)) process.loadEnvFile(path);
}

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "127.0.0.1";
const replayJsonl = await loadDefaultReplayFixture();
const mode = process.env.S0_RUNTIME_MODE === "LIVE" ? "LIVE" : "REPLAY";
const bitqueryToken = process.env.BITQUERY_TOKEN;
const zeroexApiKey = process.env.ZEROEX_API_KEY;
const jupiterApiKey = process.env.JUPITER_API_KEY;
const databaseUrl = process.env.DATABASE_URL;
const coinbasePerpProductId = mode === "LIVE"
  ? process.env.S0_COINBASE_PERP_PRODUCT ?? await discoverCoinbaseSlpProduct()
  : undefined;
if (mode === "LIVE" && !bitqueryToken) throw new Error("BITQUERY_TOKEN is required for LIVE mode");
if (mode === "LIVE" && !databaseUrl) throw new Error("DATABASE_URL is required for LIVE SIDE-011 persistence");
const app = await createApp({
  replayJsonl,
  logger: true,
  mode,
  cexProfile: mode === "LIVE" ? "coinbase" : "coinbase",
  journal: databaseUrl ? new PostgresDecisionJournal(databaseUrl) : new MemoryDecisionJournal(),
  strategyJournal: databaseUrl ? new PostgresStrategyJournal(databaseUrl) : new MemoryStrategyJournal(),
  ...(mode === "LIVE" && bitqueryToken && coinbasePerpProductId
    ? { live: { bitqueryToken, coinbasePerpProductId } }
    : {}),
  ...(zeroexApiKey || jupiterApiKey
    ? {
        paper: {
          ...(zeroexApiKey ? { zeroexApiKey } : {}),
          ...(jupiterApiKey ? { jupiterApiKey } : {})
        }
      }
    : {})
});

const close = async () => {
  await app.close();
  process.exit(0);
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

await app.listen({ port, host });
