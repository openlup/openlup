import { catalogSkuEnvelopeSelectorSchema } from "./catalogFoundationContracts.js";

/** Shares exact-code parsing with detail reads; omission alone keeps discovery broad. */
export function parseCatalogActiveSkuSelection(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new RangeError("catalog_active_sku_selection_invalid");
  }
  const codes: string[] = [];
  const seen = new Set<string>();
  for (const skuCode of value) {
    const parsed = catalogSkuEnvelopeSelectorSchema.safeParse({ kind: "sku_code", skuCode });
    if (!parsed.success || parsed.data.kind !== "sku_code" || seen.has(parsed.data.skuCode)) {
      throw new RangeError("catalog_active_sku_selection_invalid");
    }
    codes.push(parsed.data.skuCode);
    seen.add(parsed.data.skuCode);
  }
  return codes;
}
