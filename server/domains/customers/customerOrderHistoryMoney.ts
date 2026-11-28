import {
  customerOrderMoney,
  mapCustomerOrderLines as platformMapCustomerOrderLines,
  toOrderMoneyHeader,
  toOrderMoneyItem,
} from "@openlup/platform/account-support";
import type { CustomerOrderDetailResponse } from "../../../src/domains/customers/accountV2Contracts.js";
import type { CanonicalOrderMoneyLine } from "../../../src/domains/commerce/types.js";
import {
  customerLineDisplayFields,
  resolveOrderLineProductSlug,
} from "./customerLineDisplayFields.js";

export type CustomerOrderMoneyRow = Record<string, unknown>;
export { customerOrderMoney, toOrderMoneyHeader, toOrderMoneyItem };

export function mapCustomerOrderLines(
  rows: readonly CustomerOrderMoneyRow[],
  moneyLines: readonly CanonicalOrderMoneyLine[],
  currency: string,
): CustomerOrderDetailResponse["order"]["lines"] {
  return platformMapCustomerOrderLines(rows, moneyLines, currency, {
    display: hostOrderLinePresentation,
  }) as CustomerOrderDetailResponse["order"]["lines"];
}

function hostOrderLinePresentation(row: CustomerOrderMoneyRow) {
  const snapshot = record(row.product_snapshot);
  const variant = record(row.variant_snapshot);
  const title =
    firstText(variant, ["title", "name"]) ??
    firstText(snapshot, ["title", "name", "productName", "recipeName"]) ??
    "Produkt";
  const recipeName = firstText(snapshot, ["recipeName", "recipe_name"]) ?? firstText(variant, ["recipeName"]);
  const productSlug = resolveOrderLineProductSlug({ snapshot, variant, title, recipeName, firstText });
  return {
    title,
    recipeName,
    variantName:
      firstText(snapshot, ["variantName", "variant_name", "size"]) ??
      firstText(variant, ["formatCode", "format_code"]),
    ...customerLineDisplayFields(productSlug),
  };
}

function firstText(row: CustomerOrderMoneyRow, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function record(value: unknown): CustomerOrderMoneyRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as CustomerOrderMoneyRow : {};
}
