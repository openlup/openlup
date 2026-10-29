import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpRequest as VercelRequest, HttpResponse as VercelResponse } from "../../src/http/index.js";
import { createBffResponder } from "../../src/bff/index.js";
import { COMPANY_IDENTITY_CONTRACT_VERSION } from "../../src/company-identity/index.js";
import {
  createCompanyIdentityLookupHandler,
  __resetCompanyIdentityCaches,
} from "../../src/company-identity/server/index.js";

beforeEach(() => __resetCompanyIdentityCaches());

describe("company identity lookup handler", () => {
  it("coalesces concurrent identical provider lookups", async () => {
    let resolveLookup!: (value: ReturnType<typeof response>) => void;
    const lookupCompanyIdentity = vi.fn(() => new Promise<ReturnType<typeof response>>((resolve) => {
      resolveLookup = resolve;
    }));
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());
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
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());

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
      const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());

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
  it("refuses the method before parsing or lookup", async () => {
    const lookupCompanyIdentity = vi.fn();
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());
    const req = request(); req.method = "GET"; req.body = { broken: true };
    const res = createResponse();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(lookupCompanyIdentity).not.toHaveBeenCalled();
  });

  it.each([{}, { ...request().body, country: "invalid" }, { ...request().body, purpose: "unknown" }])(
    "refuses invalid input before lookup: %j", async body => {
      const lookupCompanyIdentity = vi.fn();
      const res = createResponse(); const req = request(); req.body = body;
      await createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder())(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "BAD_REQUEST" }) }));
      expect(lookupCompanyIdentity).not.toHaveBeenCalled();
    },
  );

  it("validates output without exposing private diagnostics", async () => {
    const lookupCompanyIdentity = vi.fn().mockResolvedValue({ ...response(), privateDiagnostic: "fixture-private-detail" });
    const res = createResponse();
    await createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder())(request(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "INVALID_RESPONSE" }) }));
    expect(JSON.stringify(vi.mocked(res.json).mock.calls)).not.toContain("fixture-private-detail");
  });

  it("redacts a port fault and releases the flight for retry", async () => {
    const lookupCompanyIdentity = vi.fn().mockRejectedValueOnce(new Error("fixture-private-diagnostic")).mockResolvedValueOnce(response());
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());
    const failed = createResponse(); await handler(request(), failed);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(failed.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }) }));
    expect(JSON.stringify(vi.mocked(failed.json).mock.calls)).not.toContain("fixture-private-diagnostic");
    const retried = createResponse(); await handler(request(), retried);
    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(2);
    expect(retried.status).toHaveBeenCalledWith(200);
  });

  it("bypasses both cache and coalescing for manual company data", async () => {
    const lookupCompanyIdentity = vi.fn().mockResolvedValue(response());
    const handler = createCompanyIdentityLookupHandler({ lookupPort: { lookupCompanyIdentity } }, createBffResponder());
    const req = request(); req.body = { ...req.body, manualCompany: { legalName: "Example Supply Ltd", registeredAddress: null } };
    await Promise.all([handler(req, createResponse()), handler(req, createResponse())]);
    await handler(req, createResponse());
    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(3);
  });

});

function request(identifierValue = "1234563218"): VercelRequest & { body: Record<string, unknown> } {
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
  } as unknown as VercelRequest & { body: Record<string, unknown> };
}

function response() {
  return {
    contractVersion: COMPANY_IDENTITY_CONTRACT_VERSION,
    status: "found" as const,
    verificationLevel: "registry_verified" as const,
    company: {
      country: "PL",
      identifierKind: "pl_nip",
      identifierValue: "1234563218",
      legalName: "Example Company Sp. z o.o.",
      registeredAddress: {
        line1: "Testowa 1",
        postalCode: "00-001",
        city: "Example City",
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
