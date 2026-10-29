import { sendBffError } from "../../_lib/bff/response.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";

type Env = Record<string, string | undefined>;
type Decision = { state: "open" } | { state: "invalid" } | { state: "draining"; retryAfterSeconds: number };

/** One operator-declared target pause. Every process must receive the same cut-over configuration. */
export function acquisitionLegacyDrain(env: Env, now = Date.now()): Decision {
  const started = env.OPENLUP_ACQUISITION_DRAIN_STARTED_AT;
  const maximum = env.OPENLUP_ACQUISITION_DRAIN_MAX_SECONDS;
  const ended = env.OPENLUP_ACQUISITION_DRAIN_ENDED_AT;
  if (started === undefined && maximum === undefined && ended === undefined) return { state: "open" };
  const instant = (value: string | undefined): number | null => {
    if (!value) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
  };
  const start = instant(started), end = ended === undefined ? null : instant(ended);
  const seconds = maximum && /^[1-9][0-9]*$/.test(maximum) ? Number(maximum) : NaN;
  if (start === null || !Number.isSafeInteger(seconds) || seconds > 604800 || !Number.isFinite(now)) return { state: "invalid" };
  const maximumEnd = start + seconds * 1000;
  if (now >= maximumEnd) return { state: "open" };
  if (ended !== undefined && (end === null || end < start)) return { state: "invalid" };
  const deadline = Math.min(end ?? maximumEnd, maximumEnd);
  return now < deadline ? { state: "draining", retryAfterSeconds: Math.max(1, Math.ceil((deadline - now) / 1000)) } : { state: "open" };
}

/** Refuse before an acquisition command can reach any target-key port. */
export function refuseAcquisitionCommandDuringLegacyDrain(res: VercelResponse, env: Env, now = Date.now()): boolean {
  const decision = acquisitionLegacyDrain(env, now);
  if (decision.state === "open") return false;
  if (decision.state === "invalid") {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition cut-over configuration is invalid; contact the operator", {
      details: { reason: "acquisition_cutover_configuration" },
    });
    return true;
  }
  res.setHeader("Retry-After", String(decision.retryAfterSeconds));
  sendBffError(res, "UPSTREAM_UNAVAILABLE", "Acquisition commands are paused for source replay drain; retry after the declared interval", {
    details: { reason: "acquisition_legacy_drain", retryAfterSeconds: decision.retryAfterSeconds },
  });
  return true;
}
