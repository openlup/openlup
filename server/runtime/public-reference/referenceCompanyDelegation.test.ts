import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyIdentityLookupHandler as packageHandler } from "@openlup/platform/company-identity/server";
import { createCompanyIdentityLookupHandler, __resetCompanyIdentityCaches } from "../../domains/company-identity/companyIdentityHandlers.js";
import { createCompanyIdentityLookupPort } from "../../domains/company-identity/companyIdentityService.js";
import { createInvoiceDataLookupPortFromCompanyIdentity } from "../../bff/company-identity/shared.js";
import { referenceCompanyCountry, referenceCompanyIdentityRules } from "../../adapters/market-packs/referenceCompanyIdentityRules.js";
import { bffResponder } from "../../_lib/bff/response.js";
import { installObservedRequestContext } from "../../_lib/observability/requestContext.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CompanyIdentityCompany, CompanyIdentityLookupRequest, CompanyIdentityLookupResponse, CompanyIdentitySource } from "@openlup/platform/company-identity/contracts";

const requestBody: CompanyIdentityLookupRequest = { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "1181590588", purpose: "checkout_invoice" };
const company: CompanyIdentityCompany = { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "1181590588",
  legalName: "Example Supply", registeredAddress: { line1: "Example Road 1", postalCode: "10-001", city: "Example City", country: referenceCompanyCountry },
  registryStatus: "active", regon: "123456789", vatStatus: "active" };
const source: CompanyIdentitySource = { providerKind: "example", status: "found", observedAt: "2026-01-01T00:00:00Z", evidenceHash: "sha256:example" };
const found: CompanyIdentityLookupResponse = { contractVersion: "company_identity.lookup.v1", status: "found", verificationLevel: "registry_verified", company, sources: [source], warnings: [] };

function response() {
  return { code: 0, payload: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(key: string, value: string) { this.headers[key] = value; },
    status(code: number) { this.code = code; return this; },
    json(payload: unknown) { this.payload = payload; return this; }, end() { return this; } };
}
function request(body: unknown = requestBody) {
  return { method: "POST", body, query: {}, headers: {} } as unknown as VercelRequest;
}
async function invoke(handler: ReturnType<typeof createCompanyIdentityLookupHandler>, body: unknown = requestBody) {
  const req = request(body); const res = response();
  const context = installObservedRequestContext(req, res as unknown as VercelResponse);
  await handler(req, res as unknown as VercelResponse);
  return { ...res, requestId: context.requestId };
}

afterEach(() => { __resetCompanyIdentityCaches(); vi.useRealTimers(); });

describe("reference and package company delegation", () => {
  it("shares one cache across both handler factories and resets it through the reference export", async () => {
    const lookupCompanyIdentity = vi.fn(async () => found);
    const lookupPort = { lookupCompanyIdentity };
    const reference = createCompanyIdentityLookupHandler({ lookupPort });
    const packaged = packageHandler({ lookupPort }, bffResponder, referenceCompanyIdentityRules);
    const first = await invoke(reference);
    const second = await invoke(packaged as typeof reference);
    expect(first.code).toBe(200); expect(second.code).toBe(200);
    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(1);
    expect((first.payload as { data: unknown }).data).toEqual((second.payload as { data: unknown }).data);
    __resetCompanyIdentityCaches();
    await invoke(packaged as typeof reference);
    expect(lookupCompanyIdentity).toHaveBeenCalledTimes(2);
  });

  it("preserves strict host extensions, evidence and observed request envelope", async () => {
    const port = createCompanyIdentityLookupPort({ [referenceCompanyCountry]: [{ providerKind: "example", lookup: async () => ({ status: "found", company, source }) }] });
    const result = await invoke(createCompanyIdentityLookupHandler({ lookupPort: port }));
    expect(result.code).toBe(200);
    expect(result.headers).toMatchObject({ "x-request-id": result.requestId });
    expect(result.payload).toMatchObject({ ok: true, data: { company: { regon: company.regon, vatStatus: company.vatStatus, registeredAddress: company.registeredAddress }, sources: [source] } });
    expect(result.payload).not.toHaveProperty("meta");
  });

  it("keeps invalid, manual, unsupported, unavailable and thrown outcomes distinct", async () => {
    const effects: string[] = [];
    const port = createCompanyIdentityLookupPort({ [referenceCompanyCountry]: [{ providerKind: "example", async lookup() { effects.push("lookup"); return { status: "provider_unavailable", company: null, source: { ...source, status: "provider_unavailable" } }; } }] });
    expect((await port.lookupCompanyIdentity({ ...requestBody, identifierValue: "bad" })).status).toBe("invalid");
    expect((await port.lookupCompanyIdentity({ ...requestBody, identifierKind: "custom", manualCompany: { legalName: "Manual Example" } })).verificationLevel).toBe("manual_unverified");
    expect((await port.lookupCompanyIdentity({ ...requestBody, country: "ZZ" })).status).toBe("unsupported_country");
    expect(effects).toEqual([]);
    expect((await port.lookupCompanyIdentity(requestBody)).status).toBe("provider_unavailable");
    expect(effects).toEqual(["lookup"]);
    const thrown = createCompanyIdentityLookupPort({ [referenceCompanyCountry]: [{ providerKind: "example", async lookup() { throw new Error("offline"); } }] });
    await expect(thrown.lookupCompanyIdentity(requestBody)).rejects.toThrow("offline");
    const wrapped = await invoke(createCompanyIdentityLookupHandler({ lookupPort: thrown }));
    expect(wrapped.payload).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("keeps invoice status collapse and source evidence without customer writes", async () => {
    const lookupCompanyIdentity = vi.fn(async () => found);
    const invoice = createInvoiceDataLookupPortFromCompanyIdentity({ lookupCompanyIdentity });
    const value = await invoice.lookupInvoiceData({ country: referenceCompanyCountry, taxId: requestBody.identifierValue, providerKind: "example" });
    expect(value).toMatchObject({ status: "found", legalName: company.legalName, regon: company.regon, vatStatus: company.vatStatus, evidenceHash: source.evidenceHash, address: company.registeredAddress });
    expect(lookupCompanyIdentity).toHaveBeenCalledWith(expect.objectContaining({ purpose: "checkout_invoice" }));
    const missing = createInvoiceDataLookupPortFromCompanyIdentity({ lookupCompanyIdentity: async () => ({ ...found, status: "partial", company: null }) });
    expect((await missing.lookupInvoiceData({ country: referenceCompanyCountry, taxId: requestBody.identifierValue, providerKind: "example" })).status).toBe("not_found");
  });
});
