export type OmnipackInventoryClass = "sellable" | "packaging";

export type OmnipackStockSku = {
  sku: string;
  inventoryClass: OmnipackInventoryClass;
};

type StockSkuBlocker = {
  reason: "merchant_dictionary_invalid_value";
  target: string;
  severity: "BLOCKED";
};

export const KNOWN_OMNIPACK_PACKAGING_SKUS = ["INSERTopenlup", "TASMAopenlup"] as const;

export function readOmnipackStockSkus(
  input: unknown,
  stageSkus: ReadonlyArray<{ sku: string }>,
): { stockSkus: OmnipackStockSku[]; blockers: StockSkuBlocker[] } {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length === 0) {
    return {
      stockSkus: [
        ...stageSkus.map(({ sku }) => ({ sku, inventoryClass: "sellable" as const })),
        ...KNOWN_OMNIPACK_PACKAGING_SKUS.map((sku) => ({ sku, inventoryClass: "packaging" as const })),
      ],
      blockers: [],
    };
  }

  const stockSkus: OmnipackStockSku[] = [];
  const blockers: StockSkuBlocker[] = [];
  rows.forEach((raw, index) => {
    const row = asRecord(raw);
    const sku = typeof row.sku === "string" ? row.sku.trim() : "";
    if (!sku) return blockers.push(block(`stockSkus.${index}.sku`));
    if (row.inventoryClass !== "sellable" && row.inventoryClass !== "packaging") {
      return blockers.push(block(`stockSkus.${sku}.inventoryClass`));
    }
    stockSkus.push({ sku, inventoryClass: row.inventoryClass });
  });
  return { stockSkus, blockers };
}

function block(target: string): StockSkuBlocker {
  return { reason: "merchant_dictionary_invalid_value", target, severity: "BLOCKED" };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}
