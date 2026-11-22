import { isDeepStrictEqual } from "node:util";
import { isCatalogueMoneyV2RateDecimal } from "@openlup/core/pricing";
import { array, checked, invalid, oneOf } from "../contracts/decode.js";
import type { Decode } from "../contracts/decode.js";
import type { TaxScopeV1 } from "../contracts/index.js";

export type Address = { line1: string; line2?: string; city: string; state?: string; postal_code: string; country: string };
type Charge = { amount: number; tax_code: string; tax_behavior: "exclusive" };
export type CalculationParams = {
  currency: string; tax_date: number; expand: string[];
  customer_details: { address: Address; address_source: "shipping" };
  ship_from_details: { address: Address }; shipping_cost?: Charge;
  line_items: (Charge & { reference: string; quantity: number; metadata: Record<string, string> })[];
};
type PageParams = { limit: 100; starting_after?: string };
export interface StripeQuoteClient {
  readonly scope: Readonly<Pick<TaxScopeV1, "accountRef" | "mode">>;
  calculations: {
    create(params: CalculationParams, options: { idempotencyKey: string }): Promise<unknown>;
    listLineItems(id: string, params: PageParams & { expand: string[] }): Promise<unknown>;
  };
  registrations: { list(params: PageParams & { status: "all" }): Promise<unknown> };
}

/** The SDK bridge translates confirmed idempotency conflicts at the transport boundary.
 *  The SDK bridge must also map deterministic provider rejections to refusals when it is added.
 */
export class StripeQuoteReferenceConflict extends Error {}
export class StripeQuoteUnavailable extends Error {}
export async function providerCall(read: () => Promise<unknown>): Promise<unknown> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StripeQuoteReferenceConflict) {
      invalid("/key", "This evaluation key is bound to a different calculation request. Replay the original request and digest.", "tax_reference_conflict");
    }
    throw new StripeQuoteUnavailable();
  }
}

export function incomplete(field: string, cause: string): never {
  return invalid(field, cause + " Obtain the complete provider breakdown for the original calculation request.", "tax_breakdown_incomplete");
}

export function record(value: unknown, field: string): object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) incomplete(field, "The provider field must be an object.");
  return value;
}

export function member(value: object, key: string, field: string): unknown {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property && !("value" in property)) incomplete(field, "The provider response contains an accessor.");
  return property?.value;
}

export function providerDecode<T>(decode: Decode<T>): Decode<T> {
  return (value, field) => {
    try {
      return decode(value, field);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "tax_invalid_input"
        && "field" in error && typeof error.field === "string") {
        incomplete(error.field, "The provider field is missing or malformed.");
      }
      throw error;
    }
  };
}

// Project documented fields and tolerate unrelated provider additions.
function fields<F extends Record<string, Decode<unknown>>>(shape: F): Decode<{ [K in keyof F]: ReturnType<F[K]> }> {
  return providerDecode((value, field) => {
    const source = record(value, field);
    return Object.fromEntries(Object.entries(shape).map(([key, decode]) => {
      const path = field + "/" + key;
      return [key, decode(member(source, key, path), path)];
    })) as { [K in keyof F]: ReturnType<F[K]> };
  });
}

const raw: Decode<unknown> = value => value;
export const text = providerDecode(checked((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 512
  && !v.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(v), "Obtain nonempty provider text within the supported length."));
const id = checked((v): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(v),
  "Obtain the provider object's identifier.");
const boolean = providerDecode(checked((v): v is boolean => typeof v === "boolean", "Obtain the provider's boolean value."));
const nullable = <T>(decode: Decode<T>): Decode<T | null> => (value, path) => value === null ? null : decode(value, path);
const optional = <T>(decode: Decode<T>): Decode<T | undefined> => (value, path) => value === undefined ? undefined : decode(value, path);
const minor: Decode<number> = (value, path) => {
  if (typeof value !== "number") incomplete(path, "The provider field must be a number.");
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    invalid(path, "Obtain a nonnegative, safe integer in minor units.", "tax_amount_out_of_range");
  }
  return value;
};
export const epoch: Decode<string> = (value, path) => {
  const seconds = minor(value, path);
  if (seconds > 253402300799) incomplete(path, "The provider timestamp is outside the supported UTC calendar range.");
  return new Date(seconds * 1000).toISOString();
};

export function checkScope(value: object, field: string, scope: TaxScopeV1, requireMode = false): void {
  const mode = member(value, "livemode", field + "/livemode");
  const account = member(value, "account", field + "/account");
  if ((mode !== undefined || requireMode) && boolean(mode, field + "/livemode") !== (scope.mode === "live")) {
    invalid(field + "/livemode", "The response came from a different mode. Obtain evidence from the selected mode.", "tax_scope_mismatch");
  }
  if (account !== undefined && text(account, field + "/account") !== scope.accountRef) {
    invalid(field + "/account", "The response came from a different account. Obtain evidence from the selected account.", "tax_scope_mismatch");
  }
}

const page = fields({ object: oneOf("list"), data: array(raw, 100), has_more: boolean, url: text });
export async function readPages<T extends { id: string }>(
  url: string, path: string, scope: TaxScopeV1, read: (params: PageParams) => Promise<unknown>, decode: Decode<T>, first?: unknown,
): Promise<T[]> {
  const rows = new Map<string, T>();
  let cursor: string | undefined;
  for (let index = 0; index < 10; index++) {
    const field = path + "/" + index;
    const value = index === 0 && first != null ? first
      : await providerCall(() => read({ limit: 100, ...(cursor && { starting_after: cursor }) }));
    checkScope(record(value, field), field, scope);
    const result = page(value, field);
    if (result.url !== url) incomplete(field + "/url", "The list belongs to a different resource.");
    if (!result.data.length && (result.has_more || cursor)) incomplete(field + "/data", "The continuation page is empty.");
    for (const [offset, item] of result.data.entries()) {
      const itemPath = field + "/data/" + offset;
      const row = decode(item, itemPath);
      if (rows.has(row.id)) incomplete(itemPath + "/id", "The list repeated a row or cursor.");
      rows.set(row.id, row);
      cursor = row.id;
    }
    if (!result.has_more) return [...rows.values()];
  }
  return incomplete(path, "The list exceeded the ten-page limit.");
}

const rate: Decode<string> = (value, path) => {
  if (!isCatalogueMoneyV2RateDecimal(value)) incomplete(path, "The provider rate is outside the supported decimal-percent format.");
  const [whole, fraction = ""] = value.split(".");
  const scaled = BigInt(whole + fraction.padEnd(6, "0"));
  const decimal = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return (scaled / 1_000_000n).toString() + (decimal ? "." + decimal : "");
};
const breakdown = { amount: minor, taxable_amount: minor, taxability_reason: text };
const jurisdiction = fields({ country: text, state: nullable(text), level: text, display_name: text });
export const detail = fields({
  ...breakdown, jurisdiction, sourcing: oneOf("origin", "destination"),
  tax_rate_details: nullable(fields({ tax_type: text, percentage_decimal: rate })),
});
const header = fields({ ...breakdown, inclusive: boolean, tax_rate_details: fields({
  country: nullable(text), state: nullable(text), tax_type: nullable(text), rate_type: nullable(text),
  percentage_decimal: nullable(optional(rate)), flat_amount: nullable(fields({ amount: minor, currency: text })),
}) });
const component = { amount: minor, amount_tax: minor, tax_behavior: text, tax_code: text,
  tax_breakdown(value: unknown, field: string) {
    if (value == null) incomplete(field, "The component breakdown is missing.");
    return array(detail, 128)(value, field);
  },
};
export const lineItem = fields({ ...component, object: oneOf("tax.calculation_line_item"), id,
  reference: text, quantity: minor, metadata: fields({ input_digest: text, sequence: text }) });
const address = fields({ line1: text, line2: optional(nullable(text)), city: text, postal_code: text, country: text, state: optional(nullable(text)) });
export const calculation = fields({
  object: oneOf("tax.calculation"), id, currency: text, tax_date: minor, expires_at: epoch,
  customer: optional(nullable(id)),
  customer_details: fields({ address, address_source: text, taxability_override: optional(text) }),
  ship_from_details: fields({ address }), shipping_cost: nullable(fields(component)), line_items: raw,
  tax_amount_inclusive: minor, tax_amount_exclusive: minor, amount_total: minor, tax_breakdown: array(header, 1024),
});
export const registration = fields({
  id, object: oneOf("tax.registration"), country: text, country_options: record, active_from: epoch, expires_at: nullable(epoch),
});

export function matchesEcho(actual: unknown, expected: unknown, path: string): void {
  if (!isDeepStrictEqual(actual, expected)) incomplete(path, "The response differs from the requested snapshot.");
}

export function checkCalculationScope(value: unknown, params: CalculationParams, scope: TaxScopeV1) {
  const path = "/calculation";
  const source = record(value, path);
  checkScope(source, path, scope, true);
  const shipping = member(source, "shipping_cost", path + "/shipping_cost");
  if (shipping != null) checkScope(record(shipping, path + "/shipping_cost"), path + "/shipping_cost", scope);
  const result = calculation(value, path);
  const { address_source, address: destination, taxability_override } = result.customer_details;
  for (const [actual, expected, field] of [
    [result.currency, params.currency, "/currency"], [result.tax_date, params.tax_date, "/tax_date"],
    [address_source, "shipping", "/customer_details/address_source"], [result.tax_amount_inclusive, 0, "/tax_amount_inclusive"],
    [result.customer ?? null, null, "/customer"], [taxability_override ?? "none", "none", "/customer_details/taxability_override"],
  ] as const) matchesEcho(actual, expected, path + field);
  for (const [actual, expected, field] of [
    [destination, params.customer_details.address, "/customer_details/address"],
    [result.ship_from_details.address, params.ship_from_details.address, "/ship_from_details/address"],
  ] as const) {
    for (const key of Object.keys(actual) as (keyof Address)[]) {
      matchesEcho(actual[key] ?? undefined, expected[key], path + field + "/" + key);
    }
  }
  return result;
}
