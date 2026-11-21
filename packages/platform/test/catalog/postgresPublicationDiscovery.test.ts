import { expect, it, vi } from "vitest";
import { readPostgresCatalogActivationReadiness, readPostgresCatalogMembershipPage } from "../../src/catalog/index.js";
import type { CatalogProductTypeDefinition } from "../../src/catalog/contracts/index.js";

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

const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass", integral: false }] } as unknown as CatalogProductTypeDefinition;
const registry = { resolve: () => definition };
const source = { draftId: productId, revision: 1, commandKey: "draft:1", fingerprint: digest };
const document = { id: productId, productId, revisionNo: 1, schemaId: "test:doc", documentRef: "test:doc", sourceRef: "test:source", digest };
const evidence = { head: { publicationId: productId, revision: 1, documentDigest: digest }, document, skuRevision: { skuId, revisionId: skuId, revision: 1, digest } };
const product = { id: productId, slug: "article", name: "Article", status: "active", type: { key: "example:article", version: 1 }, axes: [], attributes: {},
  primarySkuId: skuId, document, presentation: {}, source,
  content: { schemaVersion: 1, catalogAction: "create", presentation: {}, requestedModes: [], offerMemberships: [], publicationSkus: [] } };
const mass = (unscaled: string) => ({ dimension: "mass", unit: "openlup:g", unscaled, scale: 0 });
const sku = { id: skuId, productId, code: "article-100", title: "Article", status: "active", minQuantity: 1, isAddon: false, sellableStandalone: true,
  sellableInSubscription: true, netContent: mass("100"), grossMass: mass("120"), options: {}, attributes: {}, facts: {},
  identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }],
  assetRefs: [], logisticsRef: "logistics:100", memberships: [{ offerVersion: "test:offer", admitted: true }], source };
const subject = { skuCode: sku.code, evidence: { ...evidence, product, sku }, primaryPresent: true, priceReasons: [] };
const batch = (items: unknown[], headDigest = digest) => ({ kind: "batch", value: { protocol: "governed", headDigest, items } });
const readiness = { skuCodes: [sku.code, "absent-code"], expectedHeadDigest: digest };
const readyItems = [
  { skuCode: sku.code, skuId, logisticsRef: "logistics:100", evidence, ready: true, reasons: [] },
  { skuCode: "absent-code", skuId: null, logisticsRef: null, evidence: null, ready: false, reasons: ["sku_not_materialized"] },
];
const absentItem = { skuCode: "absent-code", evidence: null, primaryPresent: null, priceReasons: [] };
function owner(outcome: unknown, after?: Error) {
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
    if (outcome instanceof Error) throw outcome;
    return result(outcome);
  });
  let open = false;
  const run = vi.fn(async (work: (db: { query: typeof query }) => Promise<unknown>) => {
    open = true;
    try {
      const value = await work({ query });
      if (after) throw after;
      return value;
    } finally { open = false; }
  });
  return { lane: { run } as unknown as Parameters<typeof readPostgresCatalogActivationReadiness>[0], run, query, isOpen: () => open };
}
const sqlError = (code: string, message = code, where?: string) => Object.assign(new Error(message), { code, ...(where ? { where } : {}) });
const transactionConflict = { outcome: "conflict", reason: "catalog_publication_transaction_conflict", retryable: true };
const readUnavailable = { outcome: "dependency_unavailable", reason: "catalog_publication_read_unavailable" };

it("refuses a legacy binder, a missing assessor and invalid input before opening the owner lane", async () => {
  const { lane, run, query } = owner(batch([subject, absentItem]));
  const binder = vi.fn(() => ({ registry, assess: () => [] }));
  const rules = { registry, assess: () => [] };
  for (const [installed, request] of [
    [Object.assign(binder, rules), readiness], [{ registry }, readiness], [{ assess: () => [] }, readiness], [null, readiness],
    [rules, { ...readiness, skuCodes: [] }], [rules, { ...readiness, skuCodes: ["same", "same"] }],
    [rules, { ...readiness, skuCodes: Array.from({ length: 101 }, (_, index) => `code-${index}`) }],
    [rules, { ...readiness, skuCodes: ["has space"] }], [rules, { ...readiness, expectedHeadDigest: "A".repeat(64) }],
  ] as const) {
    expect(await readPostgresCatalogActivationReadiness(lane, installed as never, request as never))
      .toEqual({ outcome: "validation_issue", reason: "catalog_publication_readiness_input_invalid" });
  }
  expect(binder).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});

it("sets the owner transaction mode first and maps refusal values separately from SQLSTATEs, including at commit", async () => {
  const installed = { registry, assess: vi.fn(() => []) };
  const entryDenied = "permission denied for function catalog_publication_activation_readiness";
  const cases: [unknown, Error | undefined, unknown][] = [
    [batch([subject, absentItem]), undefined, { protocol: "governed", headDigest: digest, items: readyItems }],
    [refusal("invalid_request"), undefined, { outcome: "validation_issue", reason: "catalog_publication_readiness_input_invalid" }],
    [refusal("invalid_transaction_mode"), undefined, { outcome: "validation_issue", reason: "catalog_publication_readiness_transaction_invalid" }],
    [refusal("legacy"), undefined, { outcome: "unsupported", reason: "catalog_publication_not_adopted" }],
    [refusal("head_moved"), undefined, { outcome: "conflict", reason: "catalog_publication_head_moved", retryable: true }],
    [refusal("inconsistent_evidence"), undefined, readUnavailable],
    ...["catalog_publication_live_drift", "active_price_list_ambiguous", "catalog_price_setup_settlement_context_unverified"].map(detail =>
      [refusal("inconsistent_evidence", detail), undefined, { outcome: "dependency_unavailable", reason: detail }] as [unknown, undefined, unknown]),
    [sqlError("40001"), undefined, transactionConflict],
    [batch([subject, absentItem]), sqlError("40001"), transactionConflict],
    [sqlError("55P03"), undefined, { outcome: "conflict", reason: "catalog_publication_read_busy", retryable: true }],
    [sqlError("42501", entryDenied), undefined, { outcome: "unauthorized", reason: "catalog_publication_read_not_authorized" }],
    [sqlError("42501", entryDenied, "internal SQL"), undefined, readUnavailable],
    [sqlError("42501", "permission denied for function catalog_publication_readiness_snapshot", "internal SQL"), undefined, readUnavailable],
  ];
  for (const [outcome, after, expected] of cases) {
    const { lane, query } = owner(outcome, after);
    expect(await readPostgresCatalogActivationReadiness(lane, installed, readiness)).toEqual(expected);
    expect(query.mock.calls).toEqual([["SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE"],
      ["SELECT public.catalog_publication_activation_readiness($1,$2) AS result", [readiness.skuCodes, digest]]]);
  }
  expect(installed.assess).toHaveBeenCalledTimes(1);
});

it("rejects misaligned or uncertified batches", async () => {
  for (const bad of [
    batch([absentItem, subject]), batch([subject, absentItem], "b".repeat(64)), batch([subject]), batch([subject, absentItem, absentItem]),
    batch([{ ...subject, evidence: { ...subject.evidence, sku: { ...sku, code: "other" } } }, absentItem]),
    batch([{ ...subject, evidence: { ...subject.evidence, skuRevision: { ...evidence.skuRevision, skuId: productId } } }, absentItem]),
    batch([{ ...subject, evidence: { ...subject.evidence, document: { ...document, revisionNo: 2 } } }, absentItem]),
    batch([{ ...subject, priceReasons: ["price_shape_invalid", "price_readiness_missing"] }, absentItem]),
    batch([subject, { ...absentItem, priceReasons: ["price_readiness_missing"] }]), batch([subject, { ...absentItem, primaryPresent: false }]),
    { ...batch([subject, absentItem]), extra: true }, refusal("unknown_offer"),
  ]) {
    const { lane } = owner(bad);
    expect(await readPostgresCatalogActivationReadiness(lane, { registry, assess: () => [] }, readiness)).toEqual(readUnavailable);
  }
});

it("assesses detached certified subjects after the owner lane closes and keeps price reasons in SQL", async () => {
  const { lane, isOpen } = owner(batch([{ ...subject, primaryPresent: false, priceReasons: ["price_readiness_missing", "price_shape_invalid"] }, absentItem]));
  const assess = vi.fn((...args: unknown[]) => {
    expect(isOpen()).toBe(false);
    const [input] = args as [{ sku: { id: string }; evidence: { head: { revision: number } } }];
    input.sku.id = productId;
    input.evidence.head.revision = 9;
    return [...Array.from({ length: 150 }, () => "host_rule"), "primary_sku_missing", "other_rule"];
  });
  const resolve = vi.fn((_type: unknown) => definition);
  expect(await readPostgresCatalogActivationReadiness(lane, { registry: { resolve }, assess }, readiness)).toEqual({ protocol: "governed", headDigest: digest,
    items: [{ ...readyItems[0], ready: false, reasons: ["primary_sku_missing", "price_readiness_missing", "price_shape_invalid", "host_rule", "other_rule"] },
      readyItems[1]] });
  expect(assess.mock.calls.map(call => call.length)).toEqual([1]);
  expect(resolve).toHaveBeenCalledWith({ key: "example:article", version: 1 });
  for (const installed of [
    { registry, assess: () => ["price_readiness_missing"] }, { registry, assess: () => ({ ready: true, reasons: [] }) },
    { registry, assess: () => Array.from({ length: 101 }, (_, index) => `rule_${index}`) }, { registry, assess: () => ["Bad Key"] },
    { registry, assess: () => { throw sqlError("40001", "host rule"); } }, { registry, assess: async () => [] },
    { registry: { resolve: () => undefined }, assess: () => [] }, { registry: { resolve: () => ({ ...definition, version: 2 }) }, assess: () => [] },
    { registry: { resolve: () => { throw sqlError("40001", "host registry"); } }, assess: () => [] },
  ]) {
    const { lane: next } = owner(batch([subject, absentItem]));
    expect(await readPostgresCatalogActivationReadiness(next, installed as never, readiness))
      .toEqual({ outcome: "dependency_unavailable", reason: "catalog_installed_readiness_invalid" });
  }
});
