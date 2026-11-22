import { planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { invalid } from "../contracts/decode.js";
import type { TaxCoverageInputV1, TaxQuoteInputV1, TaxScopeV1 } from "../contracts/index.js";
import type { Address, CalculationParams, detail } from "./client.js";

export type Cell = TaxCoverageInputV1["required"][number];
export type Binding = Pick<Cell, "jurisdiction" | "taxKind" | "level" | "sourcing"> & {
  provider: ReturnType<typeof detail>["jurisdiction"]; taxType: string | null;
};
export type RegistrationBinding = Pick<Cell, "jurisdiction" | "taxKind"> & {
  country: string; state: string; type: "state_sales_tax" | "state_retail_delivery_fee"; complete: boolean;
};
type FiscalAddress = TaxQuoteInputV1["destination"]["address"];
type Delivery = TaxQuoteInputV1["delivery"][number];

export interface StripeQuoteMarketPack {
  scope: TaxScopeV1;
  market: string;
  currency: string;
  policyRevision: string;
  classMapRevision: string;
  taxCodes: Readonly<Record<string, string>>;
  origins: Readonly<Record<string, FiscalAddress>>;
  subdivisions: Readonly<Record<string, Readonly<Record<string, string>>>>;
  delivery: readonly (Pick<Delivery, "carrierRef" | "serviceRef" | "separatelyStated" | "taxClass"> & {
    costIndependent: boolean; zeroAmount: boolean;
  })[];
  jurisdictions: readonly Binding[];
  registrations: readonly RegistrationBinding[];
  fees: readonly (Pick<Cell, "jurisdiction" | "taxKind"> & {
    feeKey: string; layout: "top_only" | "shipping_mirror"; refundRule: { ref: string; revision: string };
  })[];
}

function own<T>(values: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

function project(address: FiscalAddress, pack: StripeQuoteMarketPack, field: string): Address {
  const { line1, line2, city, postalCode, countryCode, subdivisionCode } = address;
  const state = subdivisionCode === undefined ? undefined : own(own(pack.subdivisions, countryCode) ?? {}, subdivisionCode);
  if (subdivisionCode !== undefined && !state) {
    invalid(field + "/subdivisionCode", "The subdivision projection is missing. Qualify this address in the market pack.", "tax_rule_missing");
  }
  return { line1, ...(line2 && { line2 }), city, postal_code: postalCode, country: countryCode, ...(state && { state }) };
}

export function planQuote(input: TaxQuoteInputV1, pack: StripeQuoteMarketPack) {
  for (const key of ["adapter", "adapterVersion", "accountRef", "mode"] as const) {
    if (input.scope[key] !== pack.scope[key]) {
      invalid("/input/scope/" + key, "The quote uses a different provider scope. Use the selected account and mode.", "tax_scope_mismatch");
    }
  }
  for (const key of ["market", "currency"] as const) {
    if (input[key] !== pack[key]) invalid("/input/" + key, "Use a quote for the market pack's qualified tuple.", "tax_scope_mismatch");
  }
  for (const key of ["policyRevision", "classMapRevision"] as const) {
    if (input[key] !== pack[key]) invalid("/input/" + key, "The market pack revision differs. Supply the original pinned pack.", "tax_rule_missing");
  }
  const origin = own(pack.origins, input.shipFromRef);
  if (!origin) invalid("/input/shipFromRef", "The origin snapshot is missing. Supply the pinned origin in the market pack.", "tax_rule_missing");
  const tax_date = Date.parse(input.taxDate) / 1000;
  if (!Number.isInteger(tax_date) || tax_date < 0) invalid("/input/taxDate", "Use a whole-second UTC tax instant on or after the Unix epoch.");
  const params = {
    currency: input.currency.toLowerCase(), tax_date,
    customer_details: { address: project(input.destination.address, pack, "/input/destination/address"), address_source: "shipping" },
    ship_from_details: { address: project(origin, pack, "/input/shipFromRef") },
    expand: ["shipping_cost.tax_breakdown"],
  } satisfies Omit<CalculationParams, "line_items">;
  if (!input.money.sources.length) {
    invalid("/input/money/sources", "The basket is empty. Supply at least one positive merchandise line.", "tax_operation_unsupported");
  }
  if (input.money.delivery.length > 1 || input.money.delivery.some(item => item.deliveryKind !== "shipping")) {
    invalid("/input/money/delivery", "Use at most one shipping bucket and no handling buckets.", "tax_operation_unsupported");
  }
  const delivery = input.delivery[0];
  const rules = delivery ? pack.delivery.filter(rule => rule.carrierRef === delivery.carrierRef
    && rule.serviceRef === delivery.serviceRef && rule.taxClass === delivery.taxClass
    && rule.separatelyStated === delivery.separatelyStated) : [];
  if (delivery && (rules.length !== 1 || !rules[0].costIndependent || delivery.cost.currency !== input.currency)) {
    invalid("/input/delivery/0", "The delivery facts do not match a unique, cost-independent rule. Use a qualified service and matching cost currency.", "tax_operation_unsupported");
  }

  const components = planCatalogueMoneyV2(input.money).components.map(component => {
    const { ref, preDiscountMinor, allocations } = component;
    const index = ref.kind === "merchandise" ? input.lines.findIndex(line => line.lineKey === ref.lineKey) : 0;
    const assignment = ref.kind === "merchandise" ? input.lines[index] : delivery;
    const code = own(pack.taxCodes, assignment.taxClass);
    if (!code || !/^txcd_[0-9]+$/u.test(code)) {
      invalid(`/input/${ref.kind === "merchandise" ? "lines" : "delivery"}/${index}/taxClass`,
        "The frozen class has no provider code. Map it in the pinned class revision.", "tax_class_missing");
    }
    const source = ref.kind === "merchandise" ? input.money.sources.find(item => item.lineKey === ref.lineKey)! : undefined;
    if (source && (preDiscountMinor === 0 || allocations.some(row => row.afterMinor === 0))) {
      invalid("/input/money/sources/" + input.money.sources.indexOf(source),
        "A merchandise state is zero. Supply positive amounts before and after discounts.", "tax_operation_unsupported");
    }
    const kind = ref.kind === "merchandise" ? "line" : "delivery";
    const key = ref.kind === "merchandise" ? ref.lineKey : ref.bucketKey;
    const cells = input.required.filter(cell => cell.target.kind === kind && cell.target.key === key);
    return { ...component, assignment, code, cells, source };
  });
  const sequences = [0, ...new Set(components.flatMap(component => component.allocations.map(row => row.sequence)))].sort((a, b) => a - b);
  const initialTotal = components.reduce((sum, item) => sum + BigInt(item.preDiscountMinor), 0n);
  if (initialTotal > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid("/input/money", "The initial basket exceeds the safe minor-unit range. Reduce the pre-discount amounts.", "tax_amount_out_of_range");
  }
  if (sequences.length > 10) {
    invalid("/input/money/adjustments", "The plan exceeds ten calculation snapshots. Use at most nine distinct sequences with nonzero allocations.", "tax_operation_unsupported");
  }
  return { params, components, sequences, zeroShipping: rules[0]?.zeroAmount === true };
}

export type QuoteComponent = ReturnType<typeof planQuote>["components"][number];
