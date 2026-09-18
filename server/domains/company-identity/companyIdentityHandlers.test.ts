import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { COMPANY_IDENTITY_CONTRACT_VERSION } from "../../../src/domains/company-identity/companyIdentityContracts.js";
import {
  createCompanyIdentityLookupHandler,
  __resetCompanyIdentityCaches,
} from "./companyIdentityHandlers.js";

describe("company identity lookup handler", () => {
  it("coalesces concurrent identical provider lookups", async () => {
    let resolveLookup!: (value: ReturnType<typeof response>) => void;
    const lookupCompanyIdentity = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveLookup = resolve;
    }));
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } });
    const first = createResponse();
    const second = createResponse();

    const firstPromise = handler(request(), first);
    const secondPromise = handler(request(), second);
    resolveLookup(response());
    await Promise.all([firstPromise, secondPromise]);

    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(1);
    expect(first.status).toHaveBeenCalledWith(200);
    expect(second.status).toHaveBeenCalledWith(200);
  });

  it("serves a short TTL cache for repeated identical lookup keys", async () => {
    const lookupCompanyIdentity = vi.fn().mockResolvedValue(response());
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } });

    await handler(request("5260001246"), createResponse());
    await handler(request("5260001246"), createResponse());

    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(1);
  });

  it("evicts expired cache entries so the map stays bounded over time", async () => {
    __resetCompanyIdentityCaches();
    vi.useFakeTimers();
    try {
      // Day-keyed cache: pin a date so both lookups share the same cache key only when intended.
      vi.setSystemTime(new Date("2026-05-14T08:00:00.000Z"));
      const lookupCompanyIdentity = vi.fn().mockResolvedValue(response());
      const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } });

      // First lookup populates the cache (1 entry).
      await handler(request("0000000001"), createResponse());
      expect(lookupCompanyIdentity).toHaveBeenCalledTimes(1);

      // Advance past the 10-min TTL. The next set() triggers prune, which drops the now-expired
      // entry — so a repeat of the SAME key must miss the cache and call the provider again.
      vi.setSystemTime(new Date("2026-05-14T08:20:00.000Z"));
      await handler(request("0000000002"), createResponse()); // distinct key -> provider call + prune
      expect(lookupCompanyIdentity).toHaveBeenCalledTimes(2);

      await handler(request("0000000001"), createResponse()); // expired -> provider call (not served stale)
      expect(lookupCompanyIdentity).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
      __resetCompanyIdentityCaches();
    }
  });
});

function request(identifierValue = "1181590588"): VercelRequest {
  return {
    method: "POST",
    query: {},
    headers: {},
    body: {
      country: "PL",
      identifierKind: "pl_nip",
      identifierValue,
      purpose: "checkout_invoice",
    },
  } as unknown as VercelRequest;
}

function response() {
  return {
    contractVersion: COMPANY_IDENTITY_CONTRACT_VERSION,
    status: "found" as const,
    verificationLevel: "registry_verified" as const,
    company: {
      country: "PL",
      identifierKind: "pl_nip",
      identifierValue: "1181590588",
      legalName: "openlup Sp. z o.o.",
      registeredAddress: {
        line1: "Testowa 1",
        postalCode: "00-001",
        city: "Warszawa",
        country: "PL",
      },
      registryStatus: "active",
      regon: null,
      vatStatus: null,
    },
    sources: [{
      providerKind: "test",
      status: "found" as const,
      observedAt: "2026-05-14T08:00:00.000Z",
      evidenceHash: "evidence-1",
    }],
    warnings: [],
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
