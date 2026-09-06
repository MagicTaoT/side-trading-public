import WebSocket, { type RawData } from "ws";
import { setTimeout as wait } from "node:timers/promises";
import type {
  HttpProbeDefinition,
  ProbeResult,
  ProbeRunOptions,
  ValidationResult
} from "./contracts.js";
import { redactUrl, safeError } from "./redact.js";
import { latencyStats } from "./stats.js";

export function blockedProbe(
  id: string,
  source: string,
  label: string,
  transport: ProbeResult["transport"],
  endpoint: string,
  reason: string,
  entitlement: ProbeResult["entitlement"] = "unknown"
): ProbeResult {
  return {
    id,
    source,
    label,
    transport,
    endpoint: redactUrl(endpoint),
    status: reason.startsWith("skipped:") ? "skipped" : "blocked",
    attempts: 0,
    httpStatusCounts: {},
    rateLimited: false,
    latencyMs: latencyStats([]),
    entitlement,
    metadata: {},
    reasons: [reason]
  };
}

function addCount(counts: Record<string, number>, status: number): void {
  const key = String(status);
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function runHttpProbe(
  definition: HttpProbeDefinition,
  options: ProbeRunOptions,
  fetchImplementation: typeof fetch = fetch,
  waitImplementation: (milliseconds: number) => Promise<unknown> = wait
): Promise<ProbeResult> {
  const latencies: number[] = [];
  const httpStatusCounts: Record<string, number> = {};
  const reasons = new Set<string>();
  const metadata: Record<string, string | number | boolean | null | string[]> = {};
  let entitlement: ProbeResult["entitlement"] = "unknown";
  let passedAttempts = 0;

  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    if (attempt > 0 && definition.delayBetweenAttemptsMs) {
      await waitImplementation(definition.delayBetweenAttemptsMs);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const started = performance.now();
    try {
      const init: RequestInit = {
        method: definition.method ?? "GET",
        signal: controller.signal
      };
      if (definition.headers) init.headers = definition.headers;
      if (definition.body) init.body = definition.body;
      const response = await fetchImplementation(definition.url, init);
      latencies.push(performance.now() - started);
      addCount(httpStatusCounts, response.status);
      let value: unknown = null;
      const raw = await response.text();
      if (raw.length > 0) {
        try {
          value = JSON.parse(raw) as unknown;
        } catch {
          reasons.add("response_not_json");
        }
      }

      if (response.status === 429) reasons.add("http_429_rate_limited");
      else if (response.status === 451) reasons.add("region_restricted_http_451");
      else if (response.status === 401 || response.status === 403) reasons.add(`entitlement_http_${response.status}`);
      else if (!response.ok) reasons.add(`http_${response.status}`);

      const validation = definition.validate(value, response.status);
      entitlement = validation.entitlement ?? entitlement;
      if (response.ok) {
        Object.assign(metadata, validation.metadata ?? {});
        for (const reason of validation.reasons ?? []) reasons.add(reason);
        if (validation.pass) passedAttempts += 1;
      }
    } catch (reason) {
      latencies.push(performance.now() - started);
      reasons.add(reason instanceof DOMException && reason.name === "AbortError" ? "timeout" : `transport_error:${safeError(reason, options.secrets)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  const pass = passedAttempts === options.attempts && !Object.hasOwn(httpStatusCounts, "429");
  metadata.validatedAttempts = passedAttempts;
  if (!pass && reasons.size === 0) reasons.add(`only_${passedAttempts}_of_${options.attempts}_attempts_passed`);
  return {
    id: definition.id,
    source: definition.source,
    label: definition.label,
    transport: "http",
    endpoint: redactUrl(definition.url),
    status: pass ? "pass" : "fail",
    attempts: options.attempts,
    httpStatusCounts,
    rateLimited: Object.hasOwn(httpStatusCounts, "429"),
    latencyMs: latencyStats(latencies),
    entitlement,
    metadata,
    reasons: [...reasons].sort()
  };
}

export interface WebSocketSession {
  onOpen: (send: (payload: string) => void) => void;
  onMessage: (value: unknown, send: (payload: string) => void) => ValidationResult | null;
}

export interface WebSocketProbeDefinition {
  id: string;
  source: string;
  label: string;
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
  createSession: () => WebSocketSession;
}

interface WsAttemptResult {
  pass: boolean;
  latencyMs: number;
  metadata: Record<string, string | number | boolean | null | string[]>;
  entitlement: ProbeResult["entitlement"];
  reasons: string[];
  httpStatus: number | null;
}

function parseMessage(data: RawData): unknown {
  const text = typeof data === "string" ? data : data.toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function runWebSocketAttempt(
  definition: WebSocketProbeDefinition,
  timeoutMs: number,
  secrets: string[]
): Promise<WsAttemptResult> {
  return await new Promise((resolve) => {
    const started = performance.now();
    const session = definition.createSession();
    const socketOptions: WebSocket.ClientOptions = {};
    if (definition.headers) socketOptions.headers = definition.headers;
    const socket = definition.protocols
      ? new WebSocket(definition.url, definition.protocols, socketOptions)
      : new WebSocket(definition.url, socketOptions);
    let settled = false;
    let unexpectedStatus: number | null = null;
    const finish = (result: Omit<WsAttemptResult, "latencyMs" | "httpStatus">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve({ ...result, latencyMs: performance.now() - started, httpStatus: unexpectedStatus });
    };
    const timer = setTimeout(
      () => finish({ pass: false, metadata: {}, entitlement: "unknown", reasons: ["timeout_waiting_for_ws_evidence"] }),
      timeoutMs
    );
    const send = (payload: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    };

    socket.once("open", () => session.onOpen(send));
    socket.on("message", (data) => {
      const validation = session.onMessage(parseMessage(data), send);
      if (!validation) return;
      finish({
        pass: validation.pass,
        metadata: validation.metadata ?? {},
        entitlement: validation.entitlement ?? "unknown",
        reasons: validation.reasons ?? []
      });
    });
    socket.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      unexpectedStatus = statusCode || null;
      finish({
        pass: false,
        metadata: {},
        entitlement: statusCode === 401 || statusCode === 403 ? "credential-missing" : "unknown",
        reasons: [statusCode === 429 ? "http_429_rate_limited" : statusCode ? `ws_upgrade_http_${statusCode}` : "ws_upgrade_without_status"]
      });
    });
    socket.once("error", (reason) => {
      finish({ pass: false, metadata: {}, entitlement: "unknown", reasons: [`ws_error:${safeError(reason, secrets)}`] });
    });
    socket.once("close", (code) => {
      if (!settled) finish({ pass: false, metadata: {}, entitlement: "unknown", reasons: [`ws_closed_${code}_before_evidence`] });
    });
  });
}

export async function runWebSocketProbe(
  definition: WebSocketProbeDefinition,
  options: ProbeRunOptions
): Promise<ProbeResult> {
  const attempts: WsAttemptResult[] = [];
  for (let index = 0; index < options.attempts; index += 1) {
    attempts.push(await runWebSocketAttempt(definition, options.timeoutMs, options.secrets));
  }
  const metadata = Object.assign({}, ...attempts.map(({ metadata: item }) => item));
  const reasons = [...new Set(attempts.flatMap(({ reasons: item }) => item))].sort();
  const httpStatusCounts: Record<string, number> = {};
  for (const { httpStatus } of attempts) if (httpStatus !== null) addCount(httpStatusCounts, httpStatus);
  const pass = attempts.length === options.attempts && attempts.every((attempt) => attempt.pass);
  return {
    id: definition.id,
    source: definition.source,
    label: definition.label,
    transport: "websocket",
    endpoint: redactUrl(definition.url),
    status: pass ? "pass" : "fail",
    attempts: options.attempts,
    httpStatusCounts,
    rateLimited: Object.hasOwn(httpStatusCounts, "429") || reasons.includes("http_429_rate_limited"),
    latencyMs: latencyStats(attempts.map(({ latencyMs }) => latencyMs)),
    entitlement: attempts.find(({ entitlement: item }) => item !== "unknown")?.entitlement ?? "unknown",
    metadata,
    reasons: pass ? [] : reasons.length > 0 ? reasons : ["websocket_validation_failed"]
  };
}
