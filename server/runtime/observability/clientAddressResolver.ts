import type { VercelRequest } from "../../_lib/types/vercel.js";
import { readHostedClientAddress } from "../../adapters/vercel/runtimeProvenance.js";

type Env = Record<string, string | undefined>;

export const TRUSTED_PROXY_HOPS_ENV_KEY = "CUSTOMER_DIAGNOSTIC_TRUSTED_PROXY_HOPS";

export interface ClientAddressInput {
  /**
   * Already parsed by the caller, which owns the refusal: a malformed hop count
   * must refuse ingest, never reach a weaker rung. `null` leaves the rung unused.
   */
  trustedProxyHops: number | null;
  env: Env;
}

/**
 * Resolves the address a diagnostic admission bucket is keyed by, through rungs
 * that degrade instead of trusting a caller-chosen header (ADR 003: the host
 * adapter is one replaceable rung, the Node socket is the non-provider path).
 *
 * 1. the hop an operator declares trustworthy in `x-forwarded-for`, counted from
 *    the right — it wins over the platform header, because an operator sets it
 *    precisely when a CDN sits in front of the platform and the platform's own
 *    header then names the CDN;
 * 2. the host adapter's platform client address;
 * 3. the transport peer on a directly exposed host;
 * 4. `"unknown"` — one shared bucket, the accepted regression named in
 *    `docs/platform/RUNTIME_AND_SELF_HOSTING.md`.
 */
export function resolveClientAddress(req: VercelRequest, input: ClientAddressInput): string {
  const hops = input.trustedProxyHops;
  if (hops !== null && hops > 0) {
    const forwarded = forwardedHop(req, hops);
    // A chain that exists but is empty at the trusted hop is a caller padding
    // the header; it lands in the shared bucket rather than a weaker rung.
    if (forwarded !== null) return forwarded || "unknown";
  }
  const platform = readHostedClientAddress(req.headers ?? {}, input.env);
  if (platform) return platform.toLowerCase();
  const peer = req.socket?.remoteAddress?.trim();
  if (peer) return peer.toLowerCase();
  return "unknown";
}

function forwardedHop(req: VercelRequest, hops: number): string | null {
  const forwarded = header(req, "x-forwarded-for");
  if (!forwarded) return null;
  const entries = forwarded.split(",").map((entry) => entry.trim());
  if (hops > entries.length) return null;
  return normalizeAddress(entries[entries.length - hops] ?? "");
}

/** `[2001:db8::1]:51234` and `203.0.113.7:51234` name one peer, not one per source port. */
function normalizeAddress(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1]!.toLowerCase();
  const ipv4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return (ipv4WithPort ? ipv4WithPort[1]! : entry).toLowerCase();
}

function header(req: VercelRequest, name: string): string | null {
  const entry = Object.entries(req.headers ?? {}).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) return value[0].trim();
  return null;
}
