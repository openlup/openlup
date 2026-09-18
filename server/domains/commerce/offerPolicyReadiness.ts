export const OFFER_POLICY_V2_READINESS_CONTRACT = "commerce-offer-policy-v2-readiness.v1";

export interface OfferPolicyV2Readiness {
  contractVersion: typeof OFFER_POLICY_V2_READINESS_CONTRACT;
  ready: boolean;
  checkedAt: string;
  reasons: string[];
}

export interface OfferPolicyReadinessPort {
  readOfferPolicyV2Readiness(): Promise<unknown>;
}

interface CacheEntry {
  expiresAtMs: number;
  readiness: OfferPolicyV2Readiness;
}

export interface OfferPolicyReadinessCache {
  read(port: OfferPolicyReadinessPort): Promise<OfferPolicyV2Readiness>;
  clear(): void;
}

export function createOfferPolicyReadinessCache(input: {
  now?: () => number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
} = {}): OfferPolicyReadinessCache {
  const now = input.now ?? Date.now;
  const positiveTtlMs = Math.min(60_000, Math.max(0, input.positiveTtlMs ?? 60_000));
  const negativeTtlMs = Math.min(5_000, Math.max(0, input.negativeTtlMs ?? 5_000));
  let cached: CacheEntry | null = null;
  let inFlight: Promise<OfferPolicyV2Readiness> | null = null;

  return {
    read(port) {
      const current = now();
      if (cached && cached.expiresAtMs > current) return Promise.resolve(cached.readiness);
      if (inFlight) return inFlight;
      const startedAtMs = current;
      inFlight = loadFailClosed(port)
        .then((readiness) => {
          cached = {
            readiness,
            // Bound staleness from the start of the database read. A slow RPC
            // must consume the TTL, not extend a green decision past 60s.
            expiresAtMs: startedAtMs + (readiness.ready ? positiveTtlMs : negativeTtlMs),
          };
          return readiness;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    clear() {
      cached = null;
      inFlight = null;
    },
  };
}

const sharedCache = createOfferPolicyReadinessCache();

export function readOfferPolicyV2Readiness(
  port: OfferPolicyReadinessPort,
): Promise<OfferPolicyV2Readiness> {
  return sharedCache.read(port);
}

export function resetOfferPolicyReadinessCacheForTests(): void {
  if (process.env.NODE_ENV === "test") sharedCache.clear();
}

async function loadFailClosed(port: OfferPolicyReadinessPort): Promise<OfferPolicyV2Readiness> {
  try {
    const parsed = parseReadiness(await port.readOfferPolicyV2Readiness());
    return parsed ?? unavailable("readiness_contract_invalid");
  } catch {
    return unavailable("readiness_rpc_unavailable");
  }
}

function parseReadiness(value: unknown): OfferPolicyV2Readiness | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.contractVersion !== OFFER_POLICY_V2_READINESS_CONTRACT ||
    typeof record.ready !== "boolean" ||
    typeof record.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(record.checkedAt)) ||
    !Array.isArray(record.reasons) ||
    !record.reasons.every((reason) => typeof reason === "string")
  ) return null;
  return {
    contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
    ready: record.ready,
    checkedAt: record.checkedAt,
    reasons: record.reasons,
  };
}

function unavailable(reason: string): OfferPolicyV2Readiness {
  return {
    contractVersion: OFFER_POLICY_V2_READINESS_CONTRACT,
    ready: false,
    checkedAt: new Date(0).toISOString(),
    reasons: [reason],
  };
}
