import { canonicalizeCatalogQuantity, type CatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";

// Pure builder for the OmniPack product-registration request (catalog load). Mirrors the
// outbound-order payload convention (pure module in server/_lib, wired through the client).
// The exact OmniPack request key names live behind the constants below so finalizing them
// against the (auth-gated) OmniPack product API docs is a one-line edit.

// Product-registration request key names (confirm against the OmniPack product API docs).
const KEY_SKU = "sku";
const KEY_EAN = "ean";
const KEY_GROUP = "group";
const KEY_NAME = "name";
const KEY_DIMENSIONS = "dimensions";

export interface OmnipackProductPack {
  weightGrams: number;
  lengthMm: number;
  widthMm: number;
  heightMm: number;
}

export interface OmnipackProductInput {
  sku: string;
  ean: string | null;
  productGroup: string;
  title: string;
  pack: OmnipackProductPack | null;
}

export class OmnipackProductPayloadError extends Error {
  constructor(readonly code: string, readonly field?: string) {
    super(`omnipack_product_payload_invalid: ${code}`);
    this.name = "OmnipackProductPayloadError";
  }
}

function requireNonEmpty(value: string | null | undefined, code: string, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new OmnipackProductPayloadError(code, field);
  return trimmed;
}

function requirePositive(value: number, code: string, field: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new OmnipackProductPayloadError(code, field);
  return value;
}

// Builds the product-registration payload. EAN, group, title and a full pack are required —
// OmniPack matches physical goods by EAN and a batch-tracked group needs known dimensions.
export function buildOmnipackProductPayload(input: OmnipackProductInput): Record<string, unknown> {
  const sku = requireNonEmpty(input.sku, "missing_sku", "sku");
  const ean = requireNonEmpty(input.ean, "missing_ean", "ean");
  const group = requireNonEmpty(input.productGroup, "missing_product_group", "productGroup");
  const name = requireNonEmpty(input.title, "missing_title", "title");
  if (!input.pack) throw new OmnipackProductPayloadError("missing_pack", "pack");

  return {
    [KEY_SKU]: sku,
    [KEY_EAN]: ean,
    [KEY_GROUP]: group,
    [KEY_NAME]: name,
    [KEY_DIMENSIONS]: {
      weight: requirePositive(input.pack.weightGrams, "invalid_pack_weight", "pack.weightGrams"),
      length: requirePositive(input.pack.lengthMm, "invalid_pack_length", "pack.lengthMm"),
      width: requirePositive(input.pack.widthMm, "invalid_pack_width", "pack.widthMm"),
      height: requirePositive(input.pack.heightMm, "invalid_pack_height", "pack.heightMm"),
    },
  };
}

/** Explicit packaged gross mass for the existing product-registration lane. @experimental */
export interface TypedProductPayloadInput extends Omit<OmnipackProductInput, "pack"> {
  pack: (Omit<OmnipackProductPack, "weightGrams"> & { grossMass: CatalogQuantity | null }) | null;
  units?: readonly CatalogQuantityUnit[];
}

export function buildTypedProductPayload(input: TypedProductPayloadInput): Record<string, unknown> {
  if (!input.pack) throw new OmnipackProductPayloadError("missing_pack", "pack");
  const gross = input.pack.grossMass;
  if (gross?.dimension !== "mass") throw new OmnipackProductPayloadError("invalid_pack_weight", "pack.grossMass");
  let quantity: CatalogQuantity;
  try { quantity = canonicalizeCatalogQuantity(gross, input.units); }
  catch { throw new OmnipackProductPayloadError("invalid_pack_weight", "pack.grossMass"); }
  const { unscaled, scale } = quantity;
  const digits = unscaled.replace(/0+$/u, "");
  const exponent = unscaled.length - scale - 1;
  const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  const weightGrams = Number(`${unscaled}e-${scale}`);
  if (weightGrams.toExponential() !== `${mantissa}e${exponent < 0 ? "" : "+"}${exponent}`)
    throw new OmnipackProductPayloadError("invalid_pack_weight", "pack.grossMass");
  return buildOmnipackProductPayload({ ...input, pack: { ...input.pack, weightGrams } });
}
