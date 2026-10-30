import type {
  InvoiceDataLookupResponse,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";
import type {
  CompanyIdentityLookupResponse,
} from "../../../src/domains/company-identity/companyIdentityContracts.js";
import type { CompanyIdentityLookupPort } from "../../../src/domains/company-identity/ports.js";
import { createCeidgInvoiceDataLookupPort, readCeidgLookupConfig } from "../../adapters/ceidg/companyLookupClient.js";
import { createGusCeidgInvoiceDataLookupPort, createUnavailableInvoiceDataLookupPort, readGusCeidgLookupConfig } from "../../adapters/gusCeidg/invoiceDataLookupClient.js";
import { createMfVatInvoiceDataLookupPort, readMfVatLookupConfig } from "../../adapters/mfVat/invoiceDataLookupClient.js";
import { createStaticInvoiceDataLookupPort } from "../../domains/accounting/staticInvoiceDataLookupPort.js";
import {
  createCompanyIdentityLookupPort,
} from "../../domains/company-identity/companyIdentityService.js";
import { createReferenceCompanyIdentityProviders } from "../../adapters/market-packs/referenceCompanyIdentityProviders.js";
import { createVendorCompanyIdentityProvider, readVendorCompanyIdentityConfig } from "../../domains/company-identity/vendorCompanyIdentityProvider.js";
import { isCompleteCompanyIdentity } from "../../../src/domains/company-identity/companyIdentityContracts.js";

export function createCompanyIdentityLookupPortFromEnv(
  env: Record<string, string | undefined>,
): CompanyIdentityLookupPort {
  return createCompanyIdentityLookupPort({
    PL: createPolishProviders(env),
  });
}

export function createInvoiceDataLookupPortFromCompanyIdentity(
  lookupPort: CompanyIdentityLookupPort,
): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(request) {
      const result = await lookupPort.lookupCompanyIdentity({
        country: request.country,
        identifierKind: "pl_nip",
        identifierValue: request.taxId,
        purpose: "checkout_invoice",
      });
      return {
        ...mapCompanyIdentityToInvoiceDataLookup(result),
        providerKind: request.providerKind,
        taxId: request.taxId,
      };
    },
  };
}

function createPolishProviders(env: Record<string, string | undefined>) {
  const mode =
    env.COMPANY_IDENTITY_LOOKUP_MODE?.trim() ||
    env.COMMERCE_ACCOUNTING_INVOICE_DATA_LOOKUP_MODE?.trim() ||
    (env.VERCEL_ENV === "preview" ? "mf_vat" : "static");

  if (mode === "static") {
    return createReferenceCompanyIdentityProviders({ mode: "static", static: {
      providerKind: "static", port: createStaticInvoiceDataLookupPort(),
    } });
  }

  const vat = { providerKind: "mf_vat_whitelist", port: createMfVatInvoiceDataLookupPort(readMfVatLookupConfig(env)) };

  // Enrichment provider for the fuller sole-proprietor legal name. Prefer the
  // official CEIDG v3 API when a token is configured; otherwise fall back to the
  // generic GUS/CEIDG HTTP proxy, and finally to an unavailable stub. MF VAT runs
  // first (VAT status + address); this slot supplies `firma.nazwa`.
  const ceidgConfig = readCeidgLookupConfig(env);
  const gusConfig = readGusCeidgLookupConfig(env);
  const registry = ceidgConfig
    ? { providerKind: ceidgConfig.providerKind, port: createCeidgInvoiceDataLookupPort(ceidgConfig) }
    : { providerKind: gusConfig?.providerKind ?? "gus_ceidg_http",
      port: gusConfig ? createGusCeidgInvoiceDataLookupPort(gusConfig) : createUnavailableInvoiceDataLookupPort() };

  const vendorConfig = readVendorCompanyIdentityConfig(env);
  return createReferenceCompanyIdentityProviders({
    mode: "registry", vat,
    primaryRegistry: ceidgConfig ? registry : undefined,
    fallbackRegistry: registry,
    vendor: vendorConfig ? createVendorCompanyIdentityProvider(vendorConfig) : undefined,
  });
}

function mapCompanyIdentityToInvoiceDataLookup(
  result: CompanyIdentityLookupResponse,
): InvoiceDataLookupResponse {
  const company = result.company;
  return {
    status: result.status === "found" ? "found" : result.status === "provider_unavailable" ? "provider_unavailable" : "not_found",
    providerKind: result.sources[0]?.providerKind ?? "company_identity",
    taxId: company?.identifierValue ?? "",
    source: result.sources.map((source) => source.providerKind).join("+") || "company_identity",
    legalName: company?.legalName ?? null,
    regon: company?.regon ?? null,
    vatStatus: company?.vatStatus === "active" || company?.vatStatus === "exempt" || company?.vatStatus === "not_registered"
      ? company.vatStatus
      : "unknown",
    address: company?.registeredAddress && company.registeredAddress.country === "PL"
      ? { ...company.registeredAddress, country: "PL" }
      : null,
    evidenceHash: result.sources.find((source) => source.evidenceHash)?.evidenceHash ?? null,
    observedAt: result.sources[0]?.observedAt ?? new Date().toISOString(),
  };
}
