import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  companyIdentityLookupRequestSchema,
  companyIdentityLookupResponseSchema,
  type CompanyIdentityLookupRequest,
  type CompanyIdentityLookupResponse,
} from "../../../src/domains/company-identity/companyIdentityContracts.js";
import type { CompanyIdentityLookupPort } from "../../../src/domains/company-identity/ports.js";

const CACHE_TTL_MS = 10 * 60 * 1000;

// Bound the module-level caches so a long-lived Node process can't grow them without limit
// (W4.5 — externalize/contain in-memory hot-path state). On Vercel (per-invocation) these maps
// never outlive a request, so the bound is a no-op there; on a self-hosted Node bundle it caps
// memory. The cap is generous relative to the daily-keyed cardinality of real lookups, so the
// happy path is observationally unchanged: live (non-expired) entries are evicted only under
// sustained pressure, and only the OLDEST insertion is dropped (insertion-ordered Map).
const MAX_CACHE_ENTRIES = 5000;

interface CacheEntry {
  expiresAt: number;
  response: CompanyIdentityLookupResponse;
}

const lookupCache = new Map<string, CacheEntry>();
const inFlightLookups = new Map<string, Promise<CompanyIdentityLookupResponse>>();

/** Drop expired entries; if still over the cap, evict oldest-first until at/under the cap. */
function pruneLookupCache(now: number): void {
  for (const [key, entry] of lookupCache) {
    if (entry.expiresAt <= now) lookupCache.delete(key);
  }
  while (lookupCache.size > MAX_CACHE_ENTRIES) {
    const oldest = lookupCache.keys().next().value;
    if (oldest === undefined) break;
    lookupCache.delete(oldest);
  }
}

/** Exposed for tests only — reset module-level state between cases. */
export function __resetCompanyIdentityCaches(): void {
  lookupCache.clear();
  inFlightLookups.clear();
}

export function createCompanyIdentityLookupHandler({
  lookupPort,
}: {
  lookupPort: CompanyIdentityLookupPort;
}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);

    const request = companyIdentityLookupRequestSchema.safeParse(req.body ?? {});
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid company identity lookup request", {
        details: request.error.flatten(),
      });
      return;
    }

    try {
      const result = await lookupCompanyIdentityWithCache(lookupPort, request.data);
      const response = companyIdentityLookupResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Company identity lookup returned invalid response");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Company identity lookup failed");
    }
  };
}

async function lookupCompanyIdentityWithCache(
  lookupPort: CompanyIdentityLookupPort,
  request: CompanyIdentityLookupRequest,
): Promise<CompanyIdentityLookupResponse> {
  const cacheKey = cacheKeyFor(request);
  if (!cacheKey) return lookupPort.lookupCompanyIdentity(request);

  const cached = lookupCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.response;
  lookupCache.delete(cacheKey);

  const pending = inFlightLookups.get(cacheKey);
  if (pending) return pending;

  const lookup = lookupPort.lookupCompanyIdentity(request)
    .then((response) => {
      const at = Date.now();
      lookupCache.set(cacheKey, {
        expiresAt: at + CACHE_TTL_MS,
        response,
      });
      pruneLookupCache(at);
      return response;
    })
    .finally(() => {
      inFlightLookups.delete(cacheKey);
    });
  inFlightLookups.set(cacheKey, lookup);
  return lookup;
}

function cacheKeyFor(request: CompanyIdentityLookupRequest): string | null {
  if (request.manualCompany) return null;
  const day = new Date().toISOString().slice(0, 10);
  return [
    request.country,
    request.identifierKind,
    request.identifierValue.trim().toLowerCase(),
    day,
  ].join("|");
}
