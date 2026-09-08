import type {
  BacktestEquityPoint,
  BacktestGridField,
  BacktestVariant
} from "./contracts.js";

const INTEGER_FIELDS = new Set<BacktestGridField>([
  "entry.holdSec",
  "scaling.intervalSec",
  "scaling.maxEntries",
  "exit.forceExitSec",
  "cooldownSec"
]);

const BOOLEAN_FIELDS = new Set<BacktestGridField>([
  "scaling.enabled",
  "exit.linearDecayToZero"
]);

export const GRID_CONTROLS: { field: BacktestGridField; label: string; hint: string }[] = [
  { field: "entry.minEdgeBps", label: "MIN EDGE", hint: "e.g. 2, 3, 5" },
  { field: "entry.holdSec", label: "ENTRY HOLD SEC", hint: "e.g. 3, 5, 10" },
  { field: "entry.initialSizeQuote", label: "INITIAL SIZE", hint: "e.g. 500, 1000" },
  { field: "scaling.enabled", label: "SCALE-IN", hint: "true, false" },
  { field: "scaling.intervalSec", label: "SCALE INTERVAL SEC", hint: "e.g. 5, 10" },
  { field: "scaling.sizeMultiplier", label: "SIZE MULTIPLIER", hint: "e.g. 0.8, 1, 1.2" },
  { field: "exit.takeProfitBps", label: "TAKE PROFIT BPS", hint: "e.g. 8, 12, 20" },
  { field: "exit.stopLossBps", label: "STOP LOSS BPS", hint: "e.g. 10, 15, 25" },
  { field: "exit.forceExitSec", label: "FORCE EXIT SEC", hint: "e.g. 60, 180, 300" },
  { field: "cooldownSec", label: "COOLDOWN SEC", hint: "e.g. 0, 15, 30" }
];

export function parseGridValues(field: BacktestGridField, raw: string): unknown[] {
  const tokens = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  if (BOOLEAN_FIELDS.has(field)) {
    return tokens.map((value) => {
      if (value === "true") return true;
      if (value === "false") return false;
      throw new Error(`${field} accepts only true or false`);
    });
  }
  if (INTEGER_FIELDS.has(field)) {
    return tokens.map((value) => {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) throw new Error(`${field} requires whole numbers`);
      return parsed;
    });
  }
  return tokens.map((value) => {
    if (!Number.isFinite(Number(value))) throw new Error(`${field} requires numeric values`);
    return value;
  });
}

function sortablePnl(variant: BacktestVariant): number {
  const value = variant.summary?.totalTheoreticalPnlQuote;
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? Number.NEGATIVE_INFINITY : Number(value);
}

export function rankCompletedVariants(variants: BacktestVariant[]): BacktestVariant[] {
  return variants
    .filter(({ status, summary }) => status === "COMPLETED" && summary !== null)
    .sort((left, right) => {
      const pnlDifference = sortablePnl(right) - sortablePnl(left);
      if (pnlDifference !== 0) return pnlDifference;
      const drawdownDifference = Number(left.summary?.maxDrawdownQuote ?? Infinity) - Number(right.summary?.maxDrawdownQuote ?? Infinity);
      return drawdownDifference !== 0 ? drawdownDifference : left.configSha256.localeCompare(right.configSha256);
    });
}

export function equityPolyline(points: BacktestEquityPoint[], width: number, height: number, padding = 16): string {
  const available = points.filter((point): point is BacktestEquityPoint & { equityQuote: string } => point.equityQuote !== null && Number.isFinite(Number(point.equityQuote)));
  if (available.length === 0) return "";
  const minAt = Math.min(...available.map(({ atMs }) => atMs));
  const maxAt = Math.max(...available.map(({ atMs }) => atMs));
  const values = available.map(({ equityQuote }) => Number(equityQuote));
  const maximumMagnitude = Math.max(0, ...values.map((value) => Math.abs(value)));
  const minValue = -maximumMagnitude;
  const maxValue = maximumMagnitude;
  const timeRange = maxAt - minAt || 1;
  const valueRange = maxValue - minValue || 1;
  return available.map((point) => {
    const x = padding + ((point.atMs - minAt) / timeRange) * (width - padding * 2);
    const y = height - padding - ((Number(point.equityQuote) - minValue) / valueRange) * (height - padding * 2);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
}

export function experimentProgress(completed: number, failed: number, total: number): number {
  return total <= 0 ? 0 : Math.min(100, Math.max(0, ((completed + failed) / total) * 100));
}
