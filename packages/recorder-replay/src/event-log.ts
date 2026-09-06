import { parseMarketEvent, type MarketEvent } from "@side/market-core";

export class EventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventLogError";
  }
}

export function encodeEventLog(events: readonly MarketEvent[]): string {
  return events.map((event) => JSON.stringify(parseMarketEvent(event))).join("\n") + (events.length ? "\n" : "");
}

export function decodeEventLog(jsonl: string): MarketEvent[] {
  return jsonl
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => Boolean(line))
    .map(({ line, lineNumber }) => {
      try {
        return parseMarketEvent(JSON.parse(line) as unknown);
      } catch (error) {
        throw new EventLogError(
          `Invalid event log record at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
}
