/** Extra installed-artifact witness for the delegated reference invoice boundary. */
export const REFERENCE_DELEGATION_CONSUMER_PROOF = `
import assert from "node:assert/strict";
import { createCompanyIdentityLookupPort, createCompanyIdentityLookupHandler, __resetCompanyIdentityCaches } from "@openlup/platform/company-identity/server";
import { createCompanyIdentitySchemas, defaultCompanyIdentityRules } from "@openlup/platform/company-identity";
import { createBffResponder } from "@openlup/platform/bff";

const rules = { ...defaultCompanyIdentityRules, isValidIdentifier: (_country, _kind, value) => value === "1234" };
const schemas = createCompanyIdentitySchemas(rules);
const request = { country: "ZZ", identifierKind: "national", identifierValue: "1234", purpose: "checkout_invoice" };
const address = { line1: "Example Road 1", postalCode: "10001", city: "Example City", country: "ZZ" };
const company = { country: "ZZ", identifierKind: "national", identifierValue: "1234", legalName: "Example Supply", registeredAddress: address, registryStatus: "active", regon: "123456789", vatStatus: "active" };
const source = kind => ({ providerKind: kind, status: "found", observedAt: "2026-01-01T00:00:00Z", evidenceHash: "sha256:" + kind });
const effects = [];
const providers = [{ providerKind: "first", async lookup() { effects.push("first"); return { status: "partial", company: null, source: { ...source("first"), status: "partial" } }; } },
  { providerKind: "second", async lookup() { effects.push("second"); return { status: "found", company, source: source("second") }; } }];
const port = createCompanyIdentityLookupPort({ ZZ: providers }, rules);
const responder = createBffResponder({ responseRequestId: () => "request-ref" });
const handler = createCompanyIdentityLookupHandler({ lookupPort: port }, responder, rules);
async function invoke(input, run = handler) {
  const res = { code: 0, payload: null, headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } };
  await run({ method: "POST", body: input, headers: {}, query: {} }, res);
  return res;
}
const result = await invoke(request);
assert.equal(result.code, 200);
assert.equal(result.headers["x-request-id"], "request-ref");
assert.deepEqual(effects, ["first", "second"]);
const parsed = schemas.companyIdentityLookupResponseSchema.parse(result.payload.data);
assert.equal(parsed.company.regon, company.regon);
assert.equal(parsed.company.vatStatus, company.vatStatus);
assert.deepEqual(parsed.company.registeredAddress, address);
assert.deepEqual(parsed.sources.map(s => [s.providerKind, s.evidenceHash]), [["first", "sha256:first"], ["second", "sha256:second"]]);
assert.equal((await invoke({ ...request, identifierValue: "wrong" })).payload.data.status, "invalid");
assert.equal((await invoke({ ...request, identifierKind: "custom", manualCompany: { legalName: "Manual Example", registeredAddress: null } })).payload.data.verificationLevel, "manual_unverified");
assert.equal((await invoke({ ...request, country: "XY" })).payload.data.status, "unsupported_country");
assert.deepEqual(effects, ["first", "second"]);
__resetCompanyIdentityCaches();
const unavailable = createCompanyIdentityLookupHandler({ lookupPort: createCompanyIdentityLookupPort({ ZZ: [{ providerKind: "offline", lookup: async () => ({ status: "provider_unavailable", company: null, source: { ...source("offline"), status: "provider_unavailable" } }) }] }, rules) }, responder, rules);
assert.equal((await invoke(request, unavailable)).payload.data.status, "provider_unavailable");
__resetCompanyIdentityCaches();
const thrown = createCompanyIdentityLookupHandler({ lookupPort: createCompanyIdentityLookupPort({ ZZ: [{ providerKind: "thrown", lookup: async () => { throw Error("offline"); } }] }, rules) }, responder, rules);
assert.equal((await invoke(request, thrown)).payload.error.code, "UPSTREAM_UNAVAILABLE");
console.log("delegated installed invoice consumer PASS");
`;

/** Declarations must retain the complete host extension and evidence types. */
export const REFERENCE_DELEGATION_TYPES = [
  'import type { CompanyIdentityCompany, CompanyIdentitySource } from "@openlup/platform/company-identity/contracts";',
  'declare const company: CompanyIdentityCompany; declare const source: CompanyIdentitySource;',
  'const registry: string | null | undefined = company.regon;',
  'const status: string | null | undefined = company.vatStatus;',
  'const evidence: string | null = source.evidenceHash;',
  'void registry; void status; void evidence;',
].join("\n");
