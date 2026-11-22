import { makeTaxQuoteRequest } from "@openlup/platform/tax";
import type {
  TaxCoverageV1,
  TaxQuoteInputV1,
  TaxQuoteRequestV1,
  TaxScopeV1,
} from "@openlup/platform/tax/contracts";
import type {
  AvalaraAddress,
  AvalaraCredentials,
  AvalaraMarketPack,
  AvalaraTaxDetail,
  AvalaraTransactionResponse,
} from "../server/index.js";

export const FIXTURE_NOW_ISO = "2030-06-15T12:00:00.000Z";
export const FIXTURE_LATER_ISO = "2030-06-15T13:00:00.000Z";
export const FIXTURE_EXPIRED_ISO = "2030-06-17T12:00:00.000Z";
export const FIXTURE_COMPANY_CODE = "OPENLUP_US";

export const FIXTURE_SCOPE: TaxScopeV1 = Object.freeze({
  adapter: "avalara",
  adapterVersion: "1",
  accountRef: "avalara-acct-us-001",
  mode: "test",
});

export const FIXTURE_FOREIGN_SCOPE: TaxScopeV1 = Object.freeze({
  adapter: "avalara",
  adapterVersion: "1",
  accountRef: "avalara-acct-other-999",
  mode: "test",
});

// Constructed programmatically to keep gitleaks clean while exercising raw/URL/Base64 canary sweeps.
export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  accountId: ["2000", "9988", "77"].join(""),
  licenseKey: ["fixture", "avatax", "license", "secret", "canary"].join("_"),
  customerStreet: "1600 Canary Commerce Way",
  customerPostal: "80202",
});

export function buildFixtureCredentials(): AvalaraCredentials {
  return {
    accountId: FIXTURE_SENSITIVE_CANARIES.accountId,
    licenseKey: FIXTURE_SENSITIVE_CANARIES.licenseKey,
  };
}

export const FIXTURE_SHIP_FROM_US: AvalaraAddress = Object.freeze({
  line1: "500 Warehouse Blvd",
  city: "Denver",
  region: "CO",
  postalCode: "80201",
  country: "US",
});

export function buildFixtureMarketPack(overrides: Partial<AvalaraMarketPack> = {}): AvalaraMarketPack {
  return {
    markets: ["US"],
    currencies: ["USD"],
    taxCodes: {
      standard: "P0000000",
      exempt_food: "PF050001",
      shipping: "FR020100",
      rdf_fee: "OF400000",
    },
    shipFromOrigins: {
      "wh-us-co": FIXTURE_SHIP_FROM_US,
    },
    jurisdictions: [
      {
        jurisdiction: "US-CO",
        level: "state",
        taxKind: "sales_tax",
        sourcing: "destination",
        country: "US",
        region: "CO",
        jurisType: "STA",
        taxType: "Sales",
      },
      {
        jurisdiction: "US-OR",
        level: "state",
        taxKind: "sales_tax",
        sourcing: "destination",
        country: "US",
        region: "OR",
        jurisType: "STA",
        taxType: "Sales",
      },
      {
        jurisdiction: "US-CA",
        level: "state",
        taxKind: "sales_tax",
        sourcing: "destination",
        country: "US",
        region: "CA",
        jurisType: "STA",
        taxType: "Sales",
      },
    ],
    registrations: [
      {
        jurisdiction: "US-CO",
        taxKind: "sales_tax",
        state: "active",
        effective: { from: "2029-01-01T00:00:00.000Z" },
        evidenceRef: "reg-us-co-sales",
      },
      {
        jurisdiction: "US-CO",
        taxKind: "retail_delivery_fee",
        state: "active",
        effective: { from: "2029-01-01T00:00:00.000Z" },
        evidenceRef: "reg-us-co-rdf",
      },
      {
        jurisdiction: "US-OR",
        taxKind: "sales_tax",
        state: "inactive",
        effective: { from: "2029-01-01T00:00:00.000Z" },
        evidenceRef: "reg-us-or-inactive",
      },
      {
        jurisdiction: "US-CA",
        taxKind: "sales_tax",
        state: "inactive",
        effective: { from: "2029-01-01T00:00:00.000Z" },
        evidenceRef: "reg-us-ca-inactive",
      },
    ],
    feeBindings: [
      {
        jurisdiction: "US-CO",
        taxKind: "retail_delivery_fee",
        feeKey: "co-rdf",
        feeKind: "retail_delivery_fee",
        refundRule: { ref: "refund-a", revision: "1" },
        taxType: "RetailDeliveryFee",
      },
    ],
    ...overrides,
  };
}

export function buildCoverage(
  declarations: TaxCoverageV1["declarations"],
  accountRef = FIXTURE_SCOPE.accountRef,
): TaxCoverageV1 {
  return {
    schemaVersion: 1,
    accountRef,
    revision: "cov-rev-1",
    declarations,
  };
}

export function buildBaseQuoteInput(overrides: Partial<TaxQuoteInputV1> = {}): TaxQuoteInputV1 {
  return {
    scope: FIXTURE_SCOPE,
    market: "US",
    currency: "USD",
    money: {
      amountBasis: "exclusive",
      sources: [
        {
          lineKey: "line-1",
          sourceOrdinal: 1,
          quantity: 1,
          unitBasisMinor: 100,
        },
      ],
      delivery: [],
      adjustments: [],
      fees: [],
    },
    purpose: "final",
    taxDate: FIXTURE_NOW_ISO,
    destination: {
      snapshotRef: "dest-snap-co-1",
      digest: "d".repeat(64),
      policyRevision: "dest-pol-1",
      address: {
        line1: FIXTURE_SENSITIVE_CANARIES.customerStreet,
        city: "Denver",
        subdivisionCode: "CO",
        postalCode: FIXTURE_SENSITIVE_CANARIES.customerPostal,
        countryCode: "US",
      },
    },
    shipFromRef: "wh-us-co",
    policyRevision: "pol-rev-1",
    classMapRevision: "cls-rev-1",
    lines: [
      {
        lineKey: "line-1",
        sku: "SKU-TAX-01",
        mode: "one_time",
        taxClass: "standard",
        assignmentRef: "assign-line-1",
      },
    ],
    delivery: [],
    required: [
      {
        target: { kind: "line", key: "line-1" },
        jurisdiction: "US-CO",
        level: "state",
        taxKind: "sales_tax",
        sourcing: "destination",
      },
    ],
    coverage: buildCoverage([
      {
        jurisdiction: "US-CO",
        taxKind: "sales_tax",
        effective: { from: "2029-01-01T00:00:00.000Z" },
        actorRef: "actor-1",
        recordedAt: "2029-01-01T00:00:00.000Z",
        status: "registered",
      },
    ]),
    ...overrides,
  };
}

export function makeFixtureRequest(key: string, overrides: Partial<TaxQuoteInputV1> = {}): TaxQuoteRequestV1 {
  return makeTaxQuoteRequest(key, buildBaseQuoteInput(overrides));
}

export function buildAvalaraResponse(params: {
  readonly code: string;
  readonly status?: string;
  readonly currencyCode?: string;
  readonly lines: readonly {
    readonly lineNumber: string;
    readonly lineAmount: number;
    readonly taxableAmount: number;
    readonly tax: number;
    readonly details: readonly AvalaraTaxDetail[];
  }[];
}): AvalaraTransactionResponse {
  const totalAmount = Number(params.lines.reduce((s, l) => s + l.lineAmount, 0).toFixed(2));
  const totalTax = Number(params.lines.reduce((s, l) => s + l.tax, 0).toFixed(2));
  return {
    id: 1001,
    code: params.code,
    status: params.status ?? "Temporary",
    currencyCode: params.currencyCode ?? "USD",
    totalAmount,
    totalTax,
    lines: params.lines.map((l, idx) => ({
      id: 2000 + idx,
      lineNumber: l.lineNumber,
      lineAmount: l.lineAmount,
      taxableAmount: l.taxableAmount,
      tax: l.tax,
      taxIncluded: false,
      details: l.details,
    })),
  };
}
