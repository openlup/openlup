/** Faithful invoice lookup consumer over installed exports, with no live provider. */
export const MARKET_PACK_CONSUMER_PROOF = `
import assert from "node:assert/strict";
import { createCompanyIdentityLookupPort, createCompanyIdentityLookupHandler, __resetCompanyIdentityCaches } from "@openlup/platform/company-identity/server";
import { companyIdentityLookupRequestSchema, companyIdentityLookupResponseSchema } from "@openlup/platform/company-identity";
import { createBffResponder } from "@openlup/platform/bff";
import { readSettlementProfile, formatCurrencyMinor } from "@openlup/platform/market-packs";
const request = { country: "PL", identifierKind: "pl_nip", identifierValue: "1234563218", purpose: "checkout_invoice" };
const company = { ...request, legalName: "Example Supply Inc.", registeredAddress: { line1: "Example Road 1", postalCode: "10001", city: "Example City", country: "PL" }, registryStatus: "active", regon: "123456789", vatStatus: "active" };
delete company.purpose;
const port = createCompanyIdentityLookupPort({ PL: [{ providerKind: "fixture", lookup: async () => ({ status: "found", company, source: { providerKind: "fixture", status: "found", observedAt: "2026-01-01T00:00:00Z", evidenceHash: "sha256:fixture" } }) }] });
// This is the invoice card/client boundary: validate HTTP envelope, preserve
// complete registry identity for explicit acceptance, never write customer rows.
const handler = createCompanyIdentityLookupHandler({ lookupPort: port }, createBffResponder());
async function lookup(input, run = handler) {
  const response = { code: 0, payload: null, setHeader() {}, status(n) { this.code = n; return this; }, json(value) { this.payload = value; return this; } };
  await run({ method: "POST", body: input }, response);
  return response;
}
function acceptedInvoice(result) {
  if (result.status !== "found" || result.verificationLevel !== "registry_verified" || !result.company?.legalName || result.company.registeredAddress?.country !== "PL") return null;
  return { companyName: result.company.legalName, taxId: result.company.identifierValue, address: { ...result.company.registeredAddress } };
}
const found = await lookup(request);
assert.equal(found.code, 200);
const parsed = companyIdentityLookupResponseSchema.parse(found.payload.data);
assert.equal(parsed.status, "found"); assert.equal(parsed.company.regon, "123456789");
assert.deepEqual(parsed.company.registeredAddress, company.registeredAddress);
assert.deepEqual(acceptedInvoice(parsed), { companyName: company.legalName, taxId: "1234563218", address: company.registeredAddress });
assert.equal(acceptedInvoice({ ...parsed, company: { ...parsed.company, registeredAddress: { ...company.registeredAddress, country: "US" } } }), null);
assert.equal((await lookup({ ...request, identifierValue: "123" })).payload.data.status, "invalid");
assert.equal((await lookup({ ...request, purpose: "invalid" })).code, 400);
const manual = await lookup({ ...request, identifierKind: "custom", manualCompany: { legalName: "Manual Example", registeredAddress: null } });
assert.equal(manual.payload.data.verificationLevel, "manual_unverified");
assert.equal(acceptedInvoice(manual.payload.data), null);
__resetCompanyIdentityCaches();
const unavailable = createCompanyIdentityLookupHandler({ lookupPort: createCompanyIdentityLookupPort({ PL: [{ providerKind: "fixture", lookup: async () => ({ status: "provider_unavailable", company: null, source: { providerKind: "fixture", status: "provider_unavailable", observedAt: "2026-01-01T00:00:00Z", evidenceHash: null } }) }] }) }, createBffResponder());
const unavailableResult = (await lookup(request, unavailable)).payload.data;
assert.equal(unavailableResult.status, "provider_unavailable"); assert.equal(acceptedInvoice(unavailableResult), null);
assert.equal(companyIdentityLookupRequestSchema.parse(request).identifierValue, "1234563218");
const profile = readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: "EUR", COMMERCE_SETTLEMENT_REGION: "CZ", COMMERCE_FISCAL_COUNTRY: "DE", COMMERCE_FISCAL_CATEGORY: "standard" });
assert.equal(profile.regionCode, "CZ"); assert.equal(profile.fiscalProfile.country, "DE");
assert.equal(formatCurrencyMinor(1490, { currency: profile.defaultCurrency, locale: "en-US" }), "€14.90");
assert.equal(formatCurrencyMinor(1000, { currency: "JPY", locale: "en-US" }), "¥1,000");
console.log("market packed consumer PASS: found/invalid/manual/unavailable, registry extensions, EN/EUR independent facts");
`;
