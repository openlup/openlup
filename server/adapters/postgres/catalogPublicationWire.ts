import { createHash } from "node:crypto";
import { type CatalogHeadRef, type CatalogPublicationReceipt, type CatalogQuantity, type CatalogProductTypeRef,
  type CatalogOptionValue, type CatalogAttributeValue, type CatalogPublicationFacts, type CatalogDraftSharedContentV3,
  type CatalogDraftClaimV3, type CatalogDocumentRevisionRef } from "@openlup/platform/catalog/contracts";

/** @experimental */
export const CATALOG_PUBLICATION_LIMITS = { skuBytes: 2_097_152, manifestBytes: 16_777_216,
  receiptBytes: 8_388_608, historyBytes: 16_777_216, pageBytes: 8_388_608, pageItems: 100 } as const;
/** @experimental */
export interface CatalogPublishedIdentifier {
  scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case"; quantity: number;
  isPrimary: boolean; label: string | null; sourceRef: string | null;
}
/** @experimental */
export interface CatalogPublishedProduct {
  id: string; slug: string; name: string; status: "draft" | "active" | "archived";
  type: CatalogProductTypeRef; axes: string[]; attributes: Record<string, CatalogAttributeValue>;
  primarySkuId: string | null; document: CatalogDocumentRevisionRef | null;
  presentation: CatalogPublishedPresentation | null; source: CatalogDraftClaimV3;
  content: Omit<CatalogDraftSharedContentV3, "document" | "presentation"> & { presentation: CatalogPublishedPresentation };
}
/** @experimental */
export interface CatalogPublishedSku {
  id: string; productId: string; code: string; title: string; status: "draft" | "active" | "archived";
  minQuantity: number; isAddon: boolean; sellableStandalone: boolean; sellableInSubscription: boolean;
  netContent: CatalogQuantity; grossMass: CatalogQuantity | null; options: Record<string, CatalogOptionValue>;
  attributes: Record<string, CatalogAttributeValue>; facts: CatalogPublicationFacts;
  identifiers: CatalogPublishedIdentifier[]; assetRefs: string[]; logisticsRef: string | null;
  memberships: { offerVersion: string; admitted: boolean }[]; source: CatalogDraftClaimV3;
}
/** @experimental */
export interface CatalogSkuRevisionRef { skuId: string; revisionId: string; revision: number; digest: string }
/** @experimental */
export interface CatalogPublicationManifestV2 { schemaVersion: 2; product: CatalogPublishedProduct; skus: CatalogSkuRevisionRef[] }
/** @experimental */
export interface CatalogFullPublicationV2 { outcome: "page"; schemaVersion: 2; head: CatalogHeadRef; product: CatalogPublishedProduct;
  items: { reference: CatalogSkuRevisionRef; facts: CatalogPublishedSku }[]; nextCursor: string | null }
/** @experimental */
export interface CatalogPublicationReceiptV2 extends CatalogPublicationReceipt {
  schemaVersion: 2; productId: string; publicationDigest: string; committedAt: string;
}
/** @experimental */
export interface CatalogRetainedSourceBinding {
  kind: "account" | "order" | "fulfilment"; sourceId: string; lineId: string;
  productId: string; skuId: string; skuRevisionId: string; publicationId: string; documentRevisionId: string;
}
/** @experimental */
export interface CatalogPublicationFailure {
  outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported";
  reason: string;
  message?: string;
}

export function canonicalCatalogPublicationJson(input: unknown): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > 48) throw new Error("draft_json_depth");
    if (typeof value === "string") {
      if (value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value)) throw new Error("draft_json_invalid");
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("draft_json_invalid");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("draft_json_invalid");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("draft_json_invalid");
    for (const key of keys) {
      visit(key, depth + 1);
      if (Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set) throw new Error("draft_json_invalid");
    }
    let result: unknown;
    if (Array.isArray(value)) {
      if (keys.length !== value.length + 1) throw new Error("draft_json_invalid");
      result = Array.from(value, (item) => visit(item, depth + 1));
    } else {
      result = Object.fromEntries((keys as string[]).sort().map((key) => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
    }
    ancestors.delete(value);
    return result;
  }
  const text = JSON.stringify(visit(input, 0));
  if (new TextEncoder().encode(text).byteLength > CATALOG_PUBLICATION_LIMITS.manifestBytes) throw new Error("draft_payload_too_large");
  return text;
}

/** @experimental */
export class CatalogPublicationError extends Error {
  constructor(readonly code: string, readonly outcome: "unauthorized" | "validation_issue" | "conflict" | "dependency_unavailable" | "unsupported" = "validation_issue") {
    super(code); this.name = "CatalogPublicationError";
  }
}
export const publicationRefuse = (code: string, outcome?: CatalogPublicationError["outcome"]): never => { throw new CatalogPublicationError(code, outcome); };
export const publicationJson = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes): string => {
  const text = canonicalCatalogPublicationJson(input);
  if (Buffer.byteLength(text) > maxBytes) publicationRefuse("catalog_publication_envelope_too_large");
  return text;
};
export const publicationDigest = (input: unknown, maxBytes: number = CATALOG_PUBLICATION_LIMITS.manifestBytes): string => createHash("sha256").update(publicationJson(input, maxBytes)).digest("hex");
// The native SQL decoder owns the persisted shape.
interface CatalogPublishedPresentation {
  title?: string;
  routePath?: Record<string, string>;
  shortName?: Record<string, string>;
  advertisedWeightsG?: number[];
  mediaRef?: string;
  accent?: string;
}
