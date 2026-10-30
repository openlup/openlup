import type {
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";
import { isCompleteCompanyIdentity } from "../../../src/domains/company-identity/companyIdentityContracts.js";
import type { CompanyIdentityLookupRequest } from "@openlup/platform/company-identity/contracts";
import type { CompanyIdentityProvider, CompanyIdentityProviderResult } from "@openlup/platform/company-identity/server";
import { referenceCompanyCountry } from "./referenceCompanyIdentityRules.js";

export interface ReferenceInvoiceProvider {
  providerKind: string;
  port: InvoiceDataLookupPort;
}

/** The host resolves modes/configuration and constructs existing adapters before selection. */
export type ReferenceCompanyProviderSelection =
  | { mode: "static"; static: ReferenceInvoiceProvider }
  | {
    mode: "registry";
    vat: ReferenceInvoiceProvider;
    primaryRegistry?: ReferenceInvoiceProvider;
    fallbackRegistry: ReferenceInvoiceProvider;
    vendor?: CompanyIdentityProvider;
  };

/** Preserve VAT -> primary-or-fallback registry -> optional vendor order. No IO at construction. */
export function createReferenceCompanyIdentityProviders(
  selection: ReferenceCompanyProviderSelection,
): CompanyIdentityProvider[] {
  if (selection.mode === "static") return [invoiceProvider(selection.static)];
  const providers = [invoiceProvider(selection.vat), invoiceProvider(selection.primaryRegistry ?? selection.fallbackRegistry)];
  if (selection.vendor) providers.push(selection.vendor);
  return providers;
}

function invoiceProvider({ providerKind, port }: ReferenceInvoiceProvider): CompanyIdentityProvider {
  return {
    providerKind,
    async lookup(request) {
      const invoiceRequest: InvoiceDataLookupRequest = {
        taxId: request.identifierValue,
        country: referenceCompanyCountry,
        providerKind,
      };
      try {
        return mapInvoiceLookupResponse(await port.lookupInvoiceData(invoiceRequest), request);
      } catch {
        return {
          status: "provider_unavailable",
          company: null,
          source: { providerKind, status: "provider_unavailable", observedAt: new Date().toISOString(), evidenceHash: null },
        };
      }
    },
  };
}

function mapInvoiceLookupResponse(
  invoice: InvoiceDataLookupResponse,
  request: CompanyIdentityLookupRequest,
): CompanyIdentityProviderResult {
  const company = invoice.legalName || invoice.address
    ? {
      country: request.country,
      identifierKind: request.identifierKind,
      identifierValue: invoice.taxId,
      legalName: invoice.legalName,
      registeredAddress: invoice.address,
      registryStatus: invoice.status,
      regon: invoice.regon,
      vatStatus: invoice.vatStatus,
    }
    : null;
  const status = invoice.status === "found" && !isCompleteCompanyIdentity(company) ? "partial" : invoice.status;
  return {
    status,
    company,
    source: { providerKind: invoice.providerKind, status, observedAt: invoice.observedAt, evidenceHash: invoice.evidenceHash },
  };
}
