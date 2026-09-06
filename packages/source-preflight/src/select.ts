import type { CexProfile, ProbeResult, ProfileCandidateDecision, ProfileDecision } from "./contracts.js";
import { REQUIRED_PROBES } from "./manifest.js";

function candidate(profile: Exclude<CexProfile, "unavailable">, results: Map<string, ProbeResult>): ProfileCandidateDecision {
  const requiredProbeIds = [...REQUIRED_PROBES[profile]];
  const failedProbeIds = requiredProbeIds.filter((id) => results.get(id)?.status !== "pass");
  return { profile, complete: failedProbeIds.length === 0, requiredProbeIds, failedProbeIds };
}

export function selectCexProfile(probes: ProbeResult[]): ProfileDecision {
  const results = new Map(probes.map((probe) => [probe.id, probe]));
  const coinbase = candidate("coinbase", results);
  const binance = candidate("binance", results);
  const selected: CexProfile = coinbase.complete ? "coinbase" : binance.complete ? "binance" : "unavailable";
  const reasons =
    selected === "coinbase"
      ? ["coinbase_spot_and_perp_complete"]
      : selected === "binance"
        ? ["coinbase_profile_incomplete", "binance_spot_and_perp_complete"]
        : ["coinbase_profile_incomplete", "binance_profile_incomplete"];
  return {
    selected,
    env: `S0_CEX_PROFILE=${selected}`,
    candidates: [coinbase, binance],
    reasons
  };
}
