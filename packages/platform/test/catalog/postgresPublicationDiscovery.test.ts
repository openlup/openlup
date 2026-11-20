import { expect, it, vi } from "vitest";
import { readPostgresCatalogActivationReadiness, readPostgresCatalogMembershipPage } from "../../src/catalog/index.js";

const digest = "a".repeat(64);
const page = { offerVersion: "test:offer", limit: 1 };
const batch = { skuCodes: ["article-100"], expectedHeadDigest: digest };

it("uses the supplied membership executor and distinguishes SQL refusals from unusable envelopes", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ result: { protocol: "legacy", headDigest: null, items: [], nextCursor: null } }] })
    .mockResolvedValueOnce({ rows: [{ result: { protocol: "legacy", headDigest: null, items: [], nextCursor: {} } }] })
    .mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "42501" }))
    .mockRejectedValueOnce(Object.assign(new Error("catalog_publication_live_drift"), { code: "40001" }))
    .mockRejectedValueOnce(Object.assign(new Error("concurrent transaction"), { code: "40001" }))
    .mockRejectedValueOnce(Object.assign(new Error("unknown function"), { code: "42883" }));
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({ protocol: "legacy" });
  expect(query.mock.calls[0]?.[1]).toEqual(["test:offer", null, 1, null]);
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({ outcome: "dependency_unavailable" });
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({ outcome: "unauthorized" });
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({ outcome: "conflict", reason: "catalog_publication_live_drift" });
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({
    outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true,
  });
  expect(await readPostgresCatalogMembershipPage({ query }, page)).toMatchObject({ outcome: "dependency_unavailable" });
});

it("times out at the fence without reading authority or binding readiness", async () => {
  const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "55P03" }));
  const bind = vi.fn();
  const result = await readPostgresCatalogActivationReadiness({ run: work => work({ query }) }, bind, batch);
  expect(result).toMatchObject({ outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true });
  expect(query.mock.calls).toEqual([["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ WRITE"], ["LOCK TABLE public.catalog_products IN SHARE MODE"]]);
  expect(bind).not.toHaveBeenCalled();
});

it("rejects misaligned or incomplete readiness observations before binding", async () => {
  const bind = vi.fn();
  for (const result of [
    { protocol: "governed", headDigest: "b".repeat(64), context: null, items: [] },
    { protocol: "governed", headDigest: digest, context: null, items: [{ skuCode: "other", evidence: null, primaryPresent: null, priceShapeInvalid: null }] },
    { protocol: "governed", headDigest: digest, context: null, items: [{ skuCode: "article-100", evidence: null, primaryPresent: true, priceShapeInvalid: null }] },
  ]) {
    const query = vi.fn().mockResolvedValue({ rows: [{ result }] });
    expect(await readPostgresCatalogActivationReadiness({ run: work => work({ query }) }, bind, batch))
      .toMatchObject({ outcome: "dependency_unavailable" });
  }
  expect(bind).not.toHaveBeenCalled();
});
