import { vi } from "vitest";
import type { TaxQuoteInputV1 } from "../../../src/tax/contracts/index.js";
import { makeTaxQuoteRequest } from "../../../src/tax/digest.js";
import type { CalculationParams, StripeQuoteClient } from "../../../src/tax/stripe/client.js";
import type { Cell, StripeQuoteMarketPack } from "../../../src/tax/stripe/plan.js";
import { date, later, quote, registered } from "../fixtures.js";

export const seconds = (instant: string) => Date.parse(instant) / 1000;
export const sale = "sales_tax";
export const rdf = "retail_delivery_fee";

export const registrationUrl = "/v1/tax/registrations";
export const lineUrl = (id: string) => "/v1/tax/calculations/" + id + "/line_items";
export const page = <T>(url: string, data: T[], has_more = false) => ({ object: "list", url, data, has_more });

export function registration(id = "reg_sale", type = "state_sales_tax", from = date, until?: string) {
  return { object: "tax.registration", id, country: "XX", country_options: { xx: { state: "RA", type } },
    active_from: seconds(from), expires_at: until === undefined ? null : seconds(until), livemode: false };
}

export const providerJurisdiction = (district = "district-a") => ({
  country: "XX", state: "RA", level: "district", display_name: district,
});
export function detail(amount: number, basis: number, district = "district-a", tax_type = sale) {
  return { amount, taxable_amount: basis, jurisdiction: providerJurisdiction(district), sourcing: "destination",
    tax_rate_details: { tax_type, percentage_decimal: "10.0000" }, taxability_reason: "standard_rated" };
}
type Detail = Omit<ReturnType<typeof detail>, "tax_rate_details"> & {
  tax_rate_details: ReturnType<typeof detail>["tax_rate_details"] | null;
};

export function header(row: Detail, flat_amount: { amount: number; currency: string } | null = null) {
  return { amount: row.amount, taxable_amount: row.taxable_amount, taxability_reason: row.taxability_reason, inclusive: false,
    tax_rate_details: { country: row.jurisdiction.country, state: row.jurisdiction.state,
      percentage_decimal: row.tax_rate_details?.percentage_decimal ?? null, flat_amount,
      rate_type: flat_amount ? "flat_amount" : "percentage", tax_type: row.tax_rate_details?.tax_type ?? null } };
}

type Charge = CalculationParams["line_items"][number];
type Row = Charge & {
  object: "tax.calculation_line_item"; id: string; calculation: string; livemode: boolean;
  amount_tax: number; tax_breakdown: Detail[];
};
type Shipping = NonNullable<CalculationParams["shipping_cost"]> & { amount_tax: number; tax_breakdown: Detail[] };

export function fixture(purpose: TaxQuoteInputV1["purpose"] = "final") {
  const base = quote();
  const scope = { ...base.scope, adapter: "stripeTax" };
  const address = { ...base.destination.address, subdivisionCode: "XX-region-a" };
  const input = {
    ...base, scope, purpose, destination: { ...base.destination, address },
    money: { ...base.money, sources: [{ ...base.money.sources[0], quantity: 2, unitBasisMinor: 50 }, base.money.sources[1]],
      delivery: [{ ...base.money.delivery[0], amountMinor: 20 }], adjustments: [] as TaxQuoteInputV1["money"]["adjustments"] },
    required: base.required.filter(cell => cell.target.kind !== "fee"),
  } satisfies TaxQuoteInputV1;
  const marketPack: StripeQuoteMarketPack = {
    scope, market: input.market, currency: input.currency, policyRevision: input.policyRevision, classMapRevision: input.classMapRevision,
    taxCodes: { standard: "txcd_101", "delivery-a": "txcd_102" },
    origins: { [input.shipFromRef]: { ...address, line1: "Synthetic origin", line2: "Suite sample" } },
    subdivisions: { XX: { "XX-region-a": "RA" } },
    delivery: [{ ...base.delivery[0], costIndependent: true, zeroAmount: true }],
    jurisdictions: ["district-a", "district-b"].map(jurisdiction => ({
      jurisdiction, taxKind: "sale", level: "district", sourcing: "destination",
      provider: providerJurisdiction(jurisdiction), taxType: sale,
    })),
    registrations: ["district-a", "district-b"].map(jurisdiction => ({
      jurisdiction, taxKind: "sale", country: "XX", state: "RA", type: "state_sales_tax", complete: true,
    })),
    fees: [],
  };
  return { input, marketPack, request: () => makeTaxQuoteRequest("evaluation-a", input) };
}

export function withFee(f: ReturnType<typeof fixture>, layout: "top_only" | "shipping_mirror") {
  const cell: Cell = { target: { kind: "fee", key: "fee-a", deliveryKey: "shipping-a", taxClass: "fee-class", assignmentRef: "fee-assignment" },
    jurisdiction: "district-a", taxKind: "fee-kind", level: "district", sourcing: "destination" };
  f.input.required.push(cell);
  f.input.coverage = { ...f.input.coverage, declarations: [...f.input.coverage.declarations, { ...registered(), taxKind: "fee-kind" }] };
  f.marketPack.jurisdictions = [...f.marketPack.jurisdictions, { ...cell, provider: providerJurisdiction(), taxType: rdf }];
  f.marketPack.registrations = [...f.marketPack.registrations,
    { jurisdiction: cell.jurisdiction, taxKind: cell.taxKind, country: "XX", state: "RA", type: "state_retail_delivery_fee", complete: true }];
  f.marketPack.fees = [{ jurisdiction: cell.jurisdiction, taxKind: cell.taxKind, feeKey: cell.target.key, layout,
    refundRule: { ref: "fee-refund-a", revision: "refund-revision-a" } }];
  f.input.money.delivery[0] = { ...f.input.money.delivery[0], amountMinor: 0 };
  return detail(7, 0, "district-a", rdf);
}

export function snapshot(params: CalculationParams, index = 0, options: {
  shippingDetails?: Detail[]; lineDetails?: (line: Charge) => Detail[]; fee?: Detail;
} = {}) {
  const id = "calc_" + index;
  const lines = params.line_items.map((line, position): Row => {
    const rows = options.lineDetails?.(line) ?? [detail(Math.floor(line.amount / 10), line.amount, position === 0 ? "district-a" : "district-b")];
    return { ...line, id: "item_" + index + "_" + position, object: "tax.calculation_line_item", calculation: id, livemode: false,
      tax_breakdown: rows, amount_tax: rows.reduce((sum, row) => sum + row.amount, 0) };
  });
  const charge = params.shipping_cost;
  const shippingDetails = options.shippingDetails ?? (charge ? [detail(Math.floor(charge.amount / 10), charge.amount)] : []);
  const shipping: Shipping | null = charge
    ? { ...charge, tax_breakdown: shippingDetails, amount_tax: shippingDetails.reduce((sum, row) => sum + row.amount, 0) } : null;
  const headers = [...lines.flatMap(line => line.tax_breakdown), ...shippingDetails]
    .filter(row => row.tax_rate_details?.tax_type !== rdf).map(row => header(row));
  if (options.fee) headers.push(header(options.fee, { amount: 9, currency: params.currency }));
  const tax = headers.reduce((sum, row) => sum + row.amount, 0);
  return { id, object: "tax.calculation", livemode: false, currency: params.currency, tax_date: params.tax_date,
    customer_details: structuredClone(params.customer_details), ship_from_details: structuredClone(params.ship_from_details),
    expires_at: seconds(later), shipping_cost: shipping, tax_amount_inclusive: 0, tax_amount_exclusive: tax,
    amount_total: params.line_items.reduce((sum, line) => sum + line.amount, charge?.amount ?? 0) + tax, tax_breakdown: headers,
    line_items: page(lineUrl(id), lines) };
}

export const now = () => new Date(date);
export function fakeClient() {
  const create = vi.fn<StripeQuoteClient["calculations"]["create"]>()
    .mockImplementation(async params => snapshot(params, create.mock.calls.length - 1));
  const listLineItems = vi.fn<StripeQuoteClient["calculations"]["listLineItems"]>()
    .mockRejectedValue(new Error("Unexpected line page"));
  const list = vi.fn<StripeQuoteClient["registrations"]["list"]>().mockResolvedValue(page(registrationUrl, [registration()]));
  return { calculations: { create, listLineItems }, registrations: { list } } satisfies StripeQuoteClient;
}
