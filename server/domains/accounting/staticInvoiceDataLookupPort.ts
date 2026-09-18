import type {
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
} from "../../../src/domains/accounting/invoiceContracts.js";
import type { InvoiceDataLookupPort } from "../../../src/domains/accounting/ports.js";

const SOURCE = "local_test_fixture";
const OBSERVED_AT = "2026-06-14T00:00:00+00:00";

const FIXTURES: Record<string, Omit<InvoiceDataLookupResponse, "providerKind" | "taxId">> = {
  "1234563218": {
    status: "found",
    source: SOURCE,
    legalName: "Example Commerce Sp. z o.o.",
    regon: "012345678",
    vatStatus: "active",
    address: {
      line1: "Testowa 1",
      postalCode: "00-001",
      city: "Warszawa",
      country: "PL",
    },
    evidenceHash: "sha256:local-test-fixture-1234563218",
    observedAt: OBSERVED_AT,
  },
};

export function createStaticInvoiceDataLookupPort(): InvoiceDataLookupPort {
  return {
    async lookupInvoiceData(
      request: InvoiceDataLookupRequest,
    ): Promise<InvoiceDataLookupResponse> {
      const fixture = FIXTURES[request.taxId];
      if (fixture) {
        return {
          ...fixture,
          providerKind: request.providerKind,
          taxId: request.taxId,
        };
      }

      return {
        status: "not_found",
        providerKind: request.providerKind,
        taxId: request.taxId,
        source: SOURCE,
        legalName: null,
        regon: null,
        vatStatus: "unknown",
        address: null,
        evidenceHash: "sha256:local-test-fixture-not-found",
        observedAt: OBSERVED_AT,
      };
    },
  };
}
