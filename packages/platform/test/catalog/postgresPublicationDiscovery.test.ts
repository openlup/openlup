import { expect, it, vi } from "vitest";
import { readPostgresCatalogMembershipPage } from "../../src/catalog/index.js";

const input = { offerVersion: "test:offer", limit: 1 };
const digest = "a".repeat(64);
const skuId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const cursor = { offerVersion: input.offerVersion, headDigest: digest, skuId, mode: null };
const legacy = { protocol: "legacy", headDigest: null, items: [], nextCursor: null };
const refusal = (reason: string, detail?: string) => ({ kind: "refusal", reason, ...(detail ? { detail } : {}) });
const result = (value: unknown) => ({ rows: [{ result: value }] });

it("executes one caller statement and maps refusal values separately from SQLSTATEs", async () => {
  const query = vi.fn().mockResolvedValueOnce(result({ kind: "page", value: legacy }))
    .mockResolvedValueOnce(result(refusal("unknown_offer")))
    .mockResolvedValueOnce(result(refusal("head_moved")))
    .mockResolvedValueOnce(result(refusal("inconsistent_evidence", "catalog_publication_live_drift")))
    .mockRejectedValueOnce(Object.assign(new Error("catalog_publication_live_drift"), { code: "40001" }))
    .mockRejectedValueOnce(Object.assign(new Error("lock timeout"), { code: "55P03" }))
    .mockRejectedValueOnce(Object.assign(new Error("permission denied for function catalog_offer_memberships_page"), { code: "42501" }))
    .mockRejectedValueOnce(Object.assign(new Error("permission denied for function catalog_offer_memberships_page"), { code: "42501", where: "internal SQL" }))
    .mockRejectedValueOnce(Object.assign(new Error("permission denied for table catalog_publications"), { code: "42501" }))
    .mockRejectedValueOnce(Object.assign(new Error("catalog_offer_memberships_page_input_invalid"), { code: "22023" }));
  const outcomes = [
    legacy,
    { outcome: "validation_issue", reason: "catalog_offer_memberships_page_input_invalid" },
    { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true },
    { outcome: "dependency_unavailable", reason: "catalog_publication_live_drift" },
    { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true },
    { outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true },
    { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" },
    ...Array.from({ length: 3 }, () => ({ outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" })),
  ];
  for (const expected of outcomes) expect(await readPostgresCatalogMembershipPage({ query }, input)).toEqual(expected);
  expect(query.mock.calls).toEqual(outcomes.map(() => ["SELECT public.catalog_offer_memberships_page($1,$2,$3,$4) AS result", [input.offerVersion, null, 1, null]]));
});

it("rejects text PostgreSQL cannot encode and validates bounds before querying", async () => {
  const query = vi.fn().mockResolvedValue(result({ kind: "page", value: legacy }));
  for (const badInput of [
    { ...input, offerVersion: "nul\u0000text" }, { ...input, offerVersion: "surrogate\uD800" },
    { ...input, offerVersion: "x".repeat(241) }, { ...input, limit: 0 }, { ...input, limit: 101 },
    { ...input, limit: 1.5 }, { ...input, cursor: { ...cursor, headDigest: "A".repeat(64) } },
    { ...input, cursor: { ...cursor, offerVersion: "other-offer" } },
    { ...input, cursor: { ...cursor, mode: "one_time" as const } },
  ]) expect(await readPostgresCatalogMembershipPage({ query }, badInput)).toMatchObject({ outcome: "validation_issue" });
  expect(query).not.toHaveBeenCalled();
  expect(await readPostgresCatalogMembershipPage({ query }, { ...input, offerVersion: "offer-📦", limit: 100 })).toEqual(legacy);
});

it("rejects malformed envelopes, mismatched evidence and misaligned continuations", async () => {
  const item = {
    skuId, skuCode: "article-100", productId, productSlug: "article", netWeightG: 100,
    sellableStandalone: true, sellableInSubscription: false, presentation: null, logisticsRef: null,
    head: { publicationId: productId, revision: 1, documentDigest: digest },
    document: { id: productId, productId, revisionNo: 1, schemaId: "test:doc", documentRef: "test:doc", sourceRef: "test:source", digest },
    skuRevision: { skuId, revisionId: skuId, revision: 1, digest },
  };
  const value = { protocol: "governed", headDigest: digest, items: [item], nextCursor: cursor };
  const success = { kind: "page", value };
  const query = vi.fn().mockResolvedValueOnce(result(success));
  expect(await readPostgresCatalogMembershipPage({ query }, input)).toEqual(value);
  for (const bad of [
    legacy, { kind: "page", value: { ...legacy, nextCursor: {} } }, { ...success, extra: true },
    { kind: "refusal", reason: "unknown_offer", detail: "catalog_publication_live_drift" },
    { kind: "page", value: { ...value, items: [{ ...item, skuRevision: { ...item.skuRevision, skuId: productId } }] } },
    { kind: "page", value: { ...value, nextCursor: { ...cursor, skuId: productId } } },
    { kind: "page", value: { ...value, nextCursor: { ...cursor, offerVersion: "different" } } },
    { kind: "page", value: { ...value, nextCursor: { ...cursor, mode: "subscription" } } },
  ]) {
    query.mockResolvedValueOnce(result(bad));
    expect(await readPostgresCatalogMembershipPage({ query }, input)).toMatchObject({ outcome: "dependency_unavailable" });
  }
  query.mockResolvedValueOnce(result(success));
  expect(await readPostgresCatalogMembershipPage({ query }, { ...input, cursor })).toMatchObject({ outcome: "dependency_unavailable" });
});
