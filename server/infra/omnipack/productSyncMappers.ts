// Response mappers for the two-way OmniPack product sync (one SKU ↔ many EANs / "packs").
// Kept separate from the order/stock/fulfilment mappers so the product-sync surface stays a
// cohesive, independently-testable module. Self-contained tiny readers (no cross-file coupling)
// mirror the defensive parsing convention used in mappers.ts.
import { sanitizeOmnipackPayload } from "./mappers.js";

export interface OmnipackProductPackEvidence {
  ean: string;
  quantity: number;
}

// GET /products/{sku} — the product with its packs[]. The pack list is authoritative for what
// OmniPack currently holds; the push diff and the pull reconciliation both read it.
export interface OmnipackProductEvidence {
  provider: "omnipack";
  sku: string;
  packs: OmnipackProductPackEvidence[];
  raw: Record<string, unknown>;
}

export interface OmnipackProductPackCreatedEvidence {
  provider: "omnipack";
  sku: string;
  ean: string;
  raw: Record<string, unknown>;
}

// We tolerate a sparse body and fall back to the request-side sku; packs without an EAN are
// dropped (an EAN-less pack is not addressable for the openlup↔OmniPack diff).
export function mapOmnipackProductResponse(body: unknown, requestSku: string): OmnipackProductEvidence {
  const response = asRecord(body);
  const packs = readArray(response.packs)
    .map((entry) => {
      const pack = asRecord(entry);
      return { ean: readString(pack.ean), quantity: readNumber(pack.quantity) };
    })
    .filter((pack) => pack.ean.length > 0);
  return {
    provider: "omnipack",
    sku: readString(response.sku) || requestSku,
    packs,
    raw: sanitizeOmnipackPayload(response),
  };
}

export function mapOmnipackProductPackCreatedResponse(
  body: unknown,
  requestSku: string,
  requestEan: string,
): OmnipackProductPackCreatedEvidence {
  const response = asRecord(body);
  return {
    provider: "omnipack",
    sku: readString(response.sku) || requestSku,
    ean: readString(response.ean) || requestEan,
    raw: sanitizeOmnipackPayload(response),
  };
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function readArray(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [];
}

function readString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function readNumber(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) ? input : 0;
}
