import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";
import type { InvoiceDataLookupResponse } from "../../../src/domains/accounting/invoiceContracts.js";
import type { CompanyIdentityProvider } from "@openlup/platform/company-identity/server";
import { createCompanyIdentityLookupPort } from "@openlup/platform/company-identity/server";
import { createCompanyIdentityLookupPortFromEnv } from "../../bff/company-identity/shared.js";
import { createReferenceCompanyIdentityProviders } from "./referenceCompanyIdentityProviders.js";
import { referenceCompanyCountry, referenceCompanyIdentityRules } from "./referenceCompanyIdentityRules.js";

const state = vi.hoisted(() => ({ primary: false, fallback: false, vendor: false, ports: {} as Record<string, InvoiceDataLookupPort>, vendorProvider: undefined as CompanyIdentityProvider | undefined }));
vi.mock("../mfVat/invoiceDataLookupClient.js", () => ({ readMfVatLookupConfig: () => ({}), createMfVatInvoiceDataLookupPort: () => state.ports.vat }));
vi.mock("../ceidg/companyLookupClient.js", () => ({ readCeidgLookupConfig: () => state.primary ? { providerKind: "primary" } : null, createCeidgInvoiceDataLookupPort: () => state.ports.primary }));
vi.mock("../gusCeidg/invoiceDataLookupClient.js", () => ({ readGusCeidgLookupConfig: () => state.fallback ? { providerKind: "fallback" } : null, createGusCeidgInvoiceDataLookupPort: () => state.ports.fallback, createUnavailableInvoiceDataLookupPort: () => state.ports.unavailable }));
vi.mock("../../domains/accounting/staticInvoiceDataLookupPort.js", () => ({ createStaticInvoiceDataLookupPort: () => state.ports.static }));
vi.mock("../../domains/company-identity/vendorCompanyIdentityProvider.js", () => ({ readVendorCompanyIdentityConfig: () => state.vendor ? {} : null, createVendorCompanyIdentityProvider: () => state.vendorProvider }));
const request = { country: referenceCompanyCountry, identifierKind: "pl_nip", identifierValue: "1234563218", purpose: "checkout_invoice" as const };
let transcript: unknown[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  transcript = [];
  state.primary = false; state.fallback = false; state.vendor = false;
  for (const name of ["vat", "primary", "fallback", "unavailable", "static"]) state.ports[name] = { lookupInvoiceData: async (input) => {
    transcript.push([name, input]);
    return { status: name === "unavailable" ? "provider_unavailable" : "not_found", providerKind: input.providerKind, taxId: input.taxId, source: name, legalName: null, regon: null, vatStatus: "unknown", address: null, evidenceHash: `sha256:${name}`, observedAt: "2026-01-01T00:00:00Z" };
  } };
  state.vendorProvider = { providerKind: "vendor", lookup: async () => {
    transcript.push("vendor");
    return { status: "not_found", company: null, source: { providerKind: "vendor", status: "not_found", observedAt: "2026-01-01T00:00:00Z", evidenceHash: null } };
  } };
});
afterEach(() => vi.useRealTimers());

describe("explicit reference provider recipe versus current BFF composition", () => {
  it.each(["static", "primary", "fallback", "unavailable", "exception", "partial", "found", "enrichment"])("preserves selection, mapping and effect order: %s", async (variant) => {
    state.primary = variant === "primary";
    state.fallback = variant === "fallback";
    state.vendor = variant !== "static";
    if (variant === "exception") state.ports.vat = { lookupInvoiceData: async (input) => { transcript.push(["vat", input]); throw new Error("offline"); } };
    if (variant === "partial") state.ports.vat = { lookupInvoiceData: async (input) => {
      transcript.push(["vat", input]);
      return { status: "found", providerKind: input.providerKind, taxId: input.taxId, source: "vat", legalName: "ALEX EXAMPLE", regon: "123456789", vatStatus: "active", address: null, evidenceHash: "sha256:partial", observedAt: "2026-01-01T00:00:00Z" } satisfies InvoiceDataLookupResponse;
    } };
    if (variant === "found" || variant === "enrichment") {
      const invoice = (name: string, legalName: string): InvoiceDataLookupPort => ({ lookupInvoiceData: async (input) => {
        transcript.push([name, input]);
        return { status: "found", providerKind: input.providerKind, taxId: input.taxId, source: name, legalName, regon: "123456789", vatStatus: "active", address: { line1: `${name} Road 1`, postalCode: "10-001", city: "Example City", country: referenceCompanyCountry }, evidenceHash: `sha256:${name}`, observedAt: "2026-01-01T00:00:00Z" };
      } });
      state.ports.vat = invoice("vat", variant === "found" ? "Example Supply Trading Group Limited" : "ALEX EXAMPLE");
      state.primary = variant === "enrichment";
      state.ports.primary = invoice("primary", "Example Services Workshop Alex Example");
    }
    const current = createCompanyIdentityLookupPortFromEnv({ COMPANY_IDENTITY_LOOKUP_MODE: variant === "static" ? "static" : "registry" });
    const selection = variant === "static"
      ? { mode: "static" as const, static: { providerKind: "static", port: state.ports.static } }
      : { mode: "registry" as const, vat: { providerKind: "mf_vat_whitelist", port: state.ports.vat }, primaryRegistry: state.primary ? { providerKind: "primary", port: state.ports.primary } : undefined, fallbackRegistry: { providerKind: state.fallback ? "fallback" : "gus_ceidg_http", port: state.fallback ? state.ports.fallback : state.ports.unavailable }, vendor: state.vendorProvider };
    const providers = createReferenceCompanyIdentityProviders(selection);
    expect(transcript).toEqual([]);
    const expected = await current.lookupCompanyIdentity(request);
    const expectedTranscript = transcript.splice(0);
    const actual = await createCompanyIdentityLookupPort({ [request.country]: providers }, referenceCompanyIdentityRules).lookupCompanyIdentity(request);
    expect(actual).toEqual(expected);
    expect(transcript).toEqual(expectedTranscript);
    expect(transcript.map((entry) => typeof entry === "string" ? entry : (entry as string[])[0])).toEqual(variant === "static" ? ["static"] : variant === "found" ? ["vat"] : variant === "enrichment" ? ["vat", "primary"] : ["vat", state.primary ? "primary" : state.fallback ? "fallback" : "unavailable", "vendor"]);
  });
});
