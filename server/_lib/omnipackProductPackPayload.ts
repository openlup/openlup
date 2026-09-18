// Pure builder for the OmniPack product-pack request (POST /products/{sku}/packs). A pack is
// one EAN bound to a product: quantity === 1 is a sellable unit, quantity > 1 is a collective
// carton (N units behind one barcode). One SKU therefore maps to MANY packs (PL can / ENG can
// / collective carton). Mirrors the product/inbound payload convention (pure builder in
// server/_lib, wired through the client). The exact OmniPack request key names live behind the
// constants below so finalizing them against the (auth-gated) OmniPack product API docs is a
// one-line edit.

// Product-pack request key names (confirm against the OmniPack product-pack API docs).
const KEY_EAN = "ean";
const KEY_QUANTITY = "quantity";

export type OmnipackPackKind = "unit" | "collective";

export interface OmnipackProductPackInput {
  ean: string;
  quantity: number;
}

export class OmnipackProductPackPayloadError extends Error {
  constructor(readonly code: string) {
    super(`omnipack_product_pack_payload_invalid: ${code}`);
    this.name = "OmnipackProductPackPayloadError";
  }
}

function requireNonEmpty(value: string | null | undefined, code: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new OmnipackProductPackPayloadError(code);
  return trimmed;
}

// A pack with quantity 1 is a sellable unit; quantity > 1 is a collective carton. Pure so the
// push worker and the DB layer derive the same `kind` from the same rule.
export function omnipackPackKindForQuantity(quantity: number): OmnipackPackKind {
  return quantity > 1 ? "collective" : "unit";
}

// Builds the product-pack payload. EAN is required (OmniPack matches physical goods by barcode);
// quantity must be a positive integer (the number of sellable units behind this EAN).
export function buildOmnipackProductPackPayload(input: OmnipackProductPackInput): Record<string, unknown> {
  const ean = requireNonEmpty(input.ean, "missing_ean");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new OmnipackProductPackPayloadError("invalid_quantity");
  }
  return { [KEY_EAN]: ean, [KEY_QUANTITY]: input.quantity };
}
