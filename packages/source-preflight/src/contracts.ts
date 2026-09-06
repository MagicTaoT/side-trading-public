export type ProbeStatus = "pass" | "fail" | "blocked" | "skipped";
export type Transport = "http" | "websocket" | "credential";
export type CexProfile = "coinbase" | "binance" | "unavailable";

export type MetadataValue = string | number | boolean | null | string[];

export interface LatencyStats {
  samples: number[];
  p50: number | null;
  p95: number | null;
}

export interface ProbeResult {
  id: string;
  source: string;
  label: string;
  transport: Transport;
  endpoint: string;
  status: ProbeStatus;
  attempts: number;
  httpStatusCounts: Record<string, number>;
  rateLimited: boolean;
  latencyMs: LatencyStats;
  entitlement: "public" | "credential-present" | "credential-missing" | "not-applicable" | "unknown";
  metadata: Record<string, MetadataValue>;
  reasons: string[];
}

export interface ProfileCandidateDecision {
  profile: Exclude<CexProfile, "unavailable">;
  complete: boolean;
  requiredProbeIds: string[];
  failedProbeIds: string[];
}

export interface ProfileDecision {
  selected: CexProfile;
  env: `S0_CEX_PROFILE=${CexProfile}`;
  candidates: ProfileCandidateDecision[];
  reasons: string[];
}

export interface PreflightTarget {
  requestedRegion: string;
  hostname: string;
  platform: string;
  nodeVersion: string;
  executedAt: string;
}

export interface PreflightReport {
  schemaVersion: 1;
  manifestVersion: "s0-preflight-v1";
  target: PreflightTarget;
  profile: ProfileDecision;
  probes: ProbeResult[];
  secretPolicy: {
    valuesPersisted: false;
    environmentVariablesChecked: string[];
  };
}

export interface ValidationResult {
  pass: boolean;
  metadata?: Record<string, MetadataValue>;
  entitlement?: ProbeResult["entitlement"];
  reasons?: string[];
}

export interface HttpProbeDefinition {
  id: string;
  source: string;
  label: string;
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  delayBetweenAttemptsMs?: number;
  validate: (value: unknown, status: number) => ValidationResult;
}

export interface ProbeRunOptions {
  attempts: number;
  timeoutMs: number;
  secrets: string[];
}
