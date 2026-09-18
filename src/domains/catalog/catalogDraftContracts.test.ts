import { describe, expect, it } from "vitest";
import {
  canonicalCatalogDraftJson, catalogDraftCommandSchema, catalogDraftGetQuerySchema,
  catalogDraftListQuerySchema, catalogDraftPageSchema, catalogDraftPayloadSchema,
} from "./catalogDraftContracts.js";

const id = "10000000-0000-4000-8000-000000000001";
const payload = { schemaVersion: 1, product: { id, type: { key: "example:article", version: 1 }, dimensions: [] }, skus: [] };
const command = { schemaVersion: 1, action: "create", draftId: id, expectedRevision: 0, commandKey: "create:1", payload };

describe("catalog draft wire", () => {
  it("saves an empty product with no synthetic commercial fields", () => {
    expect(catalogDraftCommandSchema.parse(command)).toEqual(command);
    expect(catalogDraftCommandSchema.safeParse({ ...command, actorId: "invented" }).success).toBe(false);
    expect(catalogDraftCommandSchema.safeParse({ ...command, action: "abandon" }).success).toBe(false);
    expect(catalogDraftCommandSchema.safeParse({ ...command, expectedRevision: 1 }).success).toBe(false);
    expect(catalogDraftCommandSchema.safeParse({ ...command, action: "revise" }).success).toBe(false);
  });
  it("refuses foreign refs, invalid supplied values and per-SKU shared content", () => {
    expect(catalogDraftPayloadSchema.safeParse({ ...payload, product: { ...payload.product, primarySkuId: id } }).success).toBe(false);
    const sku = { id, productId: id, options: {} };
    expect(catalogDraftPayloadSchema.safeParse({ ...payload, skus: [{ ...sku, productId: "10000000-0000-4000-8000-000000000002" }] }).success).toBe(false);
    expect(catalogDraftPayloadSchema.safeParse({ ...payload, skus: [{ ...sku, sharedContent: {} }] }).success).toBe(false);
    expect(catalogDraftPayloadSchema.safeParse({ ...payload, product: { ...payload.product, sharedContent: { number: NaN } } }).success).toBe(false);
  });
  it("canonicalizes key order only, retaining every supplied payload distinction", () => {
    expect(canonicalCatalogDraftJson({ z: 2, a: 1 })).toBe(canonicalCatalogDraftJson({ a: 1, z: 2 }));
    expect(canonicalCatalogDraftJson({ amount: "10", scale: 1 })).not.toBe(canonicalCatalogDraftJson({ amount: "1", scale: 0 }));
    expect(canonicalCatalogDraftJson({ title: "a " })).not.toBe(canonicalCatalogDraftJson({ title: "a" }));
  });
  it("rejects lossy JSON, accessors, unsafe keys, recursion and byte overflow", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [undefined, NaN, Infinity, -0, 1n, new Date(), { value: undefined }, cycle, JSON.parse('{"__proto__":{}}'), new Array(2)]) {
      expect(() => canonicalCatalogDraftJson(value)).toThrow();
    }
    const getter = Object.defineProperty({}, "value", { get() { throw new Error("must_not_run"); } });
    expect(() => canonicalCatalogDraftJson(getter)).toThrow("draft_json_invalid");
    expect(() => canonicalCatalogDraftJson({ text: "é".repeat(524_288) })).toThrow("draft_payload_too_large");
    expect(() => canonicalCatalogDraftJson(Array.from({ length: 49 }).reduce((node) => [node], [] as unknown[]))).toThrow("draft_json_depth");
  });
  it("validates JSON object keys with the same Unicode rules as string values", () => {
    for (const key of ["\u0000", "\ud800", "\udc00"]) {
      const sharedContent = { [key]: "x" };
      expect(() => canonicalCatalogDraftJson({ sharedContent })).toThrow("draft_json_invalid");
      expect(catalogDraftPayloadSchema.safeParse({ ...payload, product: { ...payload.product, sharedContent } }).success).toBe(false);
    }
    const sharedContent = { "Résumé": "x", "文": "y", "😀": "z" };
    expect(JSON.parse(canonicalCatalogDraftJson({ sharedContent }))).toEqual({ sharedContent });
    expect(catalogDraftPayloadSchema.safeParse({ ...payload, product: { ...payload.product, sharedContent } }).success).toBe(true);
  });
  it("bounds pages and preserves unambiguous durable command readback", () => {
    expect(catalogDraftGetQuerySchema.safeParse({ draftId: id, revision: 1, commandKey: "key" }).success).toBe(false);
    expect(catalogDraftGetQuerySchema.safeParse({ draftId: id, commandKey: "key" }).success).toBe(true);
    expect(catalogDraftListQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(catalogDraftListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(catalogDraftPageSchema.safeParse({ items: [], nextCursor: id }).success).toBe(false);
  });
});
