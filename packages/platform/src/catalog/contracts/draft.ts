import type { CatalogDocumentRevisionRef } from "./foundation.js";
import type { CatalogProductTypeRef, CatalogOptionValue, CatalogQuantity } from "./productTypes.js";
export const CATALOG_DRAFT_MAX_BYTES = 1_048_576;
export const CATALOG_DRAFT_MAX_PAGE = 100;
export interface CatalogDraftPayload {
  schemaVersion: 1;
  product: {
    id: string; type: CatalogProductTypeRef; slug?: string; primarySkuId?: string;
    dimensions: string[]; sharedContent?: unknown; documentRevision?: CatalogDocumentRevisionRef;
  };
  skus: {
    id: string; productId: string; code?: string; options: Record<string, CatalogOptionValue>;
    netContent?: CatalogQuantity;
    identifiers?: { scheme: string; issuer: string; value: string; packagingLevel: "unit" | "case"; quantity?: number }[];
    assetRefs?: string[]; grossMass?: CatalogQuantity; priceRef?: string; logisticsRef?: string;
  }[];
}
export interface CatalogDraftCommand {
  schemaVersion: 1; action: "create" | "revise" | "abandon";
  draftId: string; commandKey: string; expectedRevision: number; payload?: CatalogDraftPayload;
}
export interface CatalogDraftSummary {
  draftId: string; productId: string; revision: number; status: "open" | "abandoned";
  commandKey: string; fingerprint: string; actorId: string; createdAt: string;
}
export interface CatalogDraftRecord extends CatalogDraftSummary { payload: CatalogDraftPayload }
export interface CatalogDraftPage { items: CatalogDraftSummary[]; nextCursor: string | null }
export interface CatalogDraftRefusal {
  outcome: "conflict" | "validation_issue" | "unauthorized" | "dependency_unavailable";
  reason: string; currentRevision?: number;
}
export type CatalogDraftApplyResult = { outcome: "committed" | "replayed"; record: CatalogDraftRecord } | CatalogDraftRefusal;
export interface CatalogDraftGetQuery { draftId: string; revision?: number; commandKey?: string }
export interface CatalogDraftListQuery { afterDraftId?: string; limit: number }

/** Reject lossy JSON inputs, prototype keys and excessive recursion before validation or hashing. */
export function canonicalCatalogDraftJson(input: unknown): string {
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (depth > 48) throw new Error("draft_json_depth");
    if (typeof value === "string") {
      if (value.includes("\u0000") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) throw new Error("draft_json_invalid");
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
  if (new TextEncoder().encode(text).byteLength > CATALOG_DRAFT_MAX_BYTES) throw new Error("draft_payload_too_large");
  return text;
}
