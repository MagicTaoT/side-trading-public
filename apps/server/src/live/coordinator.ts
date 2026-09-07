import { BitqueryLiveAdapter } from "./bitquery.js";
import { CoinbaseLiveAdapter, coinbaseInstruments } from "./coinbase.js";
import { HyperliquidLiveAdapter } from "./hyperliquid.js";
import { KrakenFuturesLiveAdapter } from "./kraken-futures.js";
import type { LiveEventSink } from "./common.js";

interface Adapter { start(): void; stop(): void; }

export interface LiveCoordinatorOptions {
  sink: LiveEventSink;
  bitqueryToken: string;
  coinbasePerpProductId: string;
}

export class LiveCoordinator {
  #adapters: Adapter[];

  constructor(options: LiveCoordinatorOptions) {
    this.#adapters = [
      new CoinbaseLiveAdapter(options.sink, coinbaseInstruments(options.coinbasePerpProductId)),
      new KrakenFuturesLiveAdapter(options.sink),
      new HyperliquidLiveAdapter(options.sink),
      new BitqueryLiveAdapter(options.sink, options.bitqueryToken)
    ];
  }

  start(): void { for (const adapter of this.#adapters) adapter.start(); }
  stop(): void { for (const adapter of this.#adapters) adapter.stop(); }
}

export async function discoverCoinbaseSlpProduct(fetchImplementation: typeof fetch = fetch): Promise<string> {
  const response = await fetchImplementation("https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE&limit=1000", {
    headers: { "cache-control": "no-cache" }
  });
  if (!response.ok) throw new Error(`Coinbase SLP discovery failed with HTTP ${response.status}`);
  const value = await response.json() as { products?: Array<{ product_id?: string }> };
  const productId = value.products
    ?.map((product) => product.product_id)
    .find((candidate): candidate is string => typeof candidate === "string" && /^SLP(?:-|$)/iu.test(candidate) && !/INTX/iu.test(candidate));
  if (!productId) throw new Error("Coinbase public SLP contract was not discovered");
  return productId;
}
