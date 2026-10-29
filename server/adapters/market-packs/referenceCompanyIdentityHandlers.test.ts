import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyIdentityLookupHandler, __resetCompanyIdentityCaches } from "@openlup/platform/company-identity/server";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { createCompanyIdentityLookupHandler as currentHandler, __resetCompanyIdentityCaches as resetCurrent } from "../../domains/company-identity/companyIdentityHandlers.js";
import { bffResponder } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { referenceCompanyCountry, referenceCompanyIdentityRules } from "./referenceCompanyIdentityRules.js";

function response() {
  const value = { statusCode: 0, payload: undefined as unknown, headers: {} as Record<string, unknown>, setHeader(key: string, content: unknown) { this.headers[key] = content; }, status(code: number) { this.statusCode = code; return this; }, json(payload: unknown) { this.payload = payload; return this; }, end() { return this; } };
  return value;
}
afterEach(() => { __resetCompanyIdentityCaches(); resetCurrent(); vi.useRealTimers(); });

describe("reference rules through the package handler", () => {
  it.each(["method", "input", "found", "invalid_output", "thrown"])("preserves envelope, parse details and lookup order: %s", async (variant) => {
    __resetCompanyIdentityCaches(); resetCurrent();
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const calls: unknown[] = [];
    const result = { contractVersion: "company_identity.lookup.v1" as const, status: "found" as const, verificationLevel: "registry_verified" as const, company: { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "1234563218", legalName: "Example Supply Inc.", registeredAddress: { line1: "Example Road 1", postalCode: "10-001", city: "Example City", country: referenceCompanyCountry }, registryStatus: "active", regon: "123456789", vatStatus: "active" }, sources: [{ providerKind: "example", status: "found" as const, observedAt: "2026-01-01T00:00:00Z", evidenceHash: "sha256:example" }], warnings: ["example_warning"] };
    const lookupPort = { lookupCompanyIdentity: vi.fn(async (input) => {
      calls.push(input);
      if (variant === "thrown") throw new Error("offline");
      return variant === "invalid_output" ? { ...result, sources: [{ ...result.sources[0], observedAt: "bad" }] } : result;
    }) };
    const input = { method: variant === "method" ? "GET" : "POST", headers: { "x-request-id": "synthetic-request" }, query: {}, body: { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "123-456-32-18", purpose: variant === "input" ? "unknown" : "checkout_invoice" } };
    const expected = response();
    await currentHandler({ lookupPort })(input as unknown as VercelRequest, expected as unknown as VercelResponse);
    const transcript = calls.splice(0);
    const actual = response();
    await createCompanyIdentityLookupHandler({ lookupPort }, bffResponder, referenceCompanyIdentityRules)(input as unknown as HttpRequest, actual as unknown as HttpResponse);
    expect(actual).toMatchObject({ statusCode: expected.statusCode, payload: expected.payload, headers: expected.headers });
    expect(calls).toEqual(transcript);
    if (variant === "method" || variant === "input") expect(calls).toEqual([]);
    else expect(calls).toMatchObject([{ identifierValue: "1234563218" }]);
  });
});
