import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalCatalogDraftJson, type CatalogDraftRecord } from "../../src/catalog/draftSchemas.js";
import { CatalogDraftStoreError, type CatalogDraftStorePort, type CatalogLifecycleDraftStorePort } from "../../src/catalog/draftPorts.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { createCatalogDraftHandler, createCatalogDraftHandlerV4 } from "../../src/catalog/draftHandler.js";

const draftId = "10000000-0000-4000-8000-000000000001";
const productId = "20000000-0000-4000-8000-000000000001";
const command = { schemaVersion: 1 as const, action: "create" as const, draftId, commandKey: "first", expectedRevision: 0,
  payload: { schemaVersion: 1 as const, product: { id: productId, type: { key: "example:article", version: 1 }, dimensions: [] }, skus: [] } };
const canonical = canonicalCatalogDraftJson(command);
const original: CatalogDraftRecord = { draftId, productId, revision: 1, status: "open", commandKey: "first",
  fingerprint: createHash("sha256").update(canonical).digest("hex"), actorId: "operator:one", createdAt: "2026-09-08T00:00:00Z", payload: command.payload };
function setup() {
  const store = { get: vi.fn<CatalogDraftStorePort["get"]>().mockResolvedValue(null),
    apply: vi.fn<CatalogDraftStorePort["apply"]>().mockResolvedValue({ outcome: "committed", record: original }),
    list: vi.fn<CatalogDraftStorePort["list"]>().mockResolvedValue({ items: [], nextCursor: null }) };
  const registry = createCatalogProductTypeRegistry([{ key: "example:article", version: 1,
    units: [{ code: "item:piece", dimension: "count", integral: true }], netContentUnits: ["item:piece"], dimensions: [], validateContent: () => [] }]);
  const authorizeOperator = vi.fn().mockResolvedValue({ actorId: "operator:one" });
  return { store, registry, authorizeOperator, handler: createCatalogDraftHandler({ store, registry, authorizeOperator }) };
}

describe("dark draft use case", () => {
  it("derives the actor and fingerprints exact server canonical bytes", async () => {
    const { handler, store } = setup();
    expect(await handler.execute(command, {})).toMatchObject({ outcome: "committed", record: original, readiness: { publication: { status: "incomplete" } } });
    expect(store.apply).toHaveBeenCalledWith({ canonicalCommand: canonical, fingerprint: original.fingerprint, actorId: "operator:one" });
    expect(await handler.execute({ ...command, actorId: "forged" }, {})).toMatchObject({ outcome: "validation_issue" });
    expect(store.apply).toHaveBeenCalledTimes(1);
  });
  it("replays original receipt before moved head, abandonment or changed installed registry", async () => {
    const { store, authorizeOperator } = setup(); store.get.mockResolvedValue(original);
    const handler = createCatalogDraftHandler({ store, authorizeOperator, registry: createCatalogProductTypeRegistry([]) });
    expect(await handler.execute(command, {})).toEqual({ outcome: "replayed", record: original });
    expect(store.get).toHaveBeenCalledWith({ draftId, commandKey: "first" }, "operator:one");
    expect(store.apply).not.toHaveBeenCalled();
    expect(await handler.execute({ ...command, payload: { ...command.payload, product: { ...command.payload.product, slug: "changed" } } }, {})).toMatchObject({ outcome: "conflict", reason: "draft_command_key_reused" });
    store.get.mockResolvedValue({ ...original, actorId: "operator:other" });
    expect(await handler.execute(command, {})).toMatchObject({ outcome: "unauthorized" });
  });
  it("denies before reads and distinguishes unavailable authorization", async () => {
    const { handler, store, authorizeOperator } = setup(); authorizeOperator.mockResolvedValue(null);
    expect(await handler.execute(command, {})).toMatchObject({ outcome: "unauthorized" });
    expect(await handler.get({ draftId }, {})).toMatchObject({ outcome: "unauthorized" });
    expect(await handler.list({ limit: 1 }, {})).toMatchObject({ outcome: "unauthorized" });
    expect(store.get).not.toHaveBeenCalled();
    authorizeOperator.mockRejectedValue(new Error("private text"));
    expect(await handler.execute(command, {})).toEqual({ outcome: "dependency_unavailable", reason: "draft_dependency_unavailable" });
  });
  it("returns conflicts safely and treats a lost response as unknown until durable command readback", async () => {
    const { handler, store } = setup();
    store.apply.mockRejectedValueOnce(new Error("private driver payload"));
    expect(await handler.execute(command, {})).toEqual({ outcome: "dependency_unavailable", reason: "draft_dependency_unavailable" });
    store.get.mockResolvedValueOnce(original);
    expect(await handler.get({ draftId, commandKey: "first" }, {})).toEqual({ outcome: "found", record: original });
    store.apply.mockResolvedValueOnce({ outcome: "conflict", reason: "draft_revision_conflict", currentRevision: 2 });
    expect(await handler.execute(command, {})).toMatchObject({ outcome: "conflict", currentRevision: 2 });
    store.get.mockRejectedValueOnce(new CatalogDraftStoreError({ outcome: "unauthorized", reason: "draft_operator_required" }));
    expect(await handler.get({ draftId }, {})).toMatchObject({ outcome: "unauthorized" });
  });
  it("fails closed on corrupt or mismatched persistence and refuses invalid new drafts", async () => {
    const { handler, store } = setup();
    store.apply.mockResolvedValueOnce({ outcome: "committed", record: { ...original, fingerprint: "b".repeat(64) } });
    expect(await handler.execute(command, {})).toMatchObject({ outcome: "dependency_unavailable" });
    store.get.mockResolvedValueOnce({ ...original, draftId: productId });
    expect(await handler.get({ draftId }, {})).toMatchObject({ outcome: "dependency_unavailable" });
    const unknown = { ...command, payload: { ...command.payload, product: { ...command.payload.product, type: { key: "other:type", version: 1 } } } };
    expect(await handler.execute(unknown, {})).toMatchObject({ outcome: "validation_issue", issues: [{ path: "product.type", code: "type_not_installed" }] });
    expect(store.apply).toHaveBeenCalledTimes(1);
  });
  it("bounds readback/list without silently interpreting dependency failure as empty", async () => {
    const { handler, store } = setup();
    expect(await handler.list({ limit: 101 }, {})).toMatchObject({ outcome: "validation_issue" });
    expect(store.list).not.toHaveBeenCalled();
    expect(await handler.list({ limit: 1 }, {})).toEqual({ outcome: "listed", page: { items: [], nextCursor: null } });
    store.list.mockRejectedValueOnce(new Error("offline"));
    expect(await handler.list({ limit: 1 }, {})).toMatchObject({ outcome: "dependency_unavailable" });
    expect(await handler.get({ draftId, revision: 1, commandKey: "first" }, {})).toMatchObject({ outcome: "validation_issue" });
  });
});

it("keeps version two behind explicit composition", async () => {
  const { handler, store } = setup();
  expect(await handler.execute({ ...command, schemaVersion: 2, payload: { ...command.payload, schemaVersion: 2 } }, {}))
    .toEqual({ outcome: "validation_issue", reason: "draft_input_invalid" });
  expect(store.get).not.toHaveBeenCalled();
  expect(store.apply).not.toHaveBeenCalled();
});

it("uses the v4 wire for identity and reads stored v4 payloads without lowering operations", async () => {
  const { registry, authorizeOperator } = setup();
  const payload = { ...command.payload, schemaVersion: 4 as const,
    product: { ...command.payload.product, sharedContent: { schemaVersion: 1 as const, catalogAction: "create" as const,
      presentation: {}, offerMemberships: [], requestedModes: [], publicationSkus: [] } },
    publication: { kind: "release" as const, evidence: {}, operations: [
      { op: "restore_product" as const, productSlug: "example", expectedState: "withdrawn" as const },
    ] } };
  const v4 = { ...command, schemaVersion: 4, payload };
  const canonicalCommand = canonicalCatalogDraftJson(v4);
  const fingerprint = createHash("sha256").update(canonicalCommand).digest("hex");
  const record = { ...original, payload, fingerprint };
  const store = {
    apply: vi.fn<CatalogLifecycleDraftStorePort["apply"]>().mockResolvedValue({ outcome: "committed", record }),
    get: vi.fn<CatalogLifecycleDraftStorePort["get"]>().mockResolvedValueOnce(null).mockResolvedValue(record),
    list: vi.fn<CatalogLifecycleDraftStorePort["list"]>().mockResolvedValue({ items: [record], nextCursor: null }),
  };
  const handler = createCatalogDraftHandlerV4({ registry, authorizeOperator, store });
  expect(await handler.execute(v4, {})).toMatchObject({ outcome: "committed", record });
  expect(store.apply).toHaveBeenCalledWith({ canonicalCommand, fingerprint, actorId: original.actorId });
  expect(await handler.get({ draftId }, {})).toEqual({ outcome: "found", record });
  expect(await handler.list({ limit: 1 }, {})).toEqual({ outcome: "listed", page: { items: [record], nextCursor: null } });
  expect(await handler.execute(v4, {})).toEqual({ outcome: "replayed", record });
  expect(await handler.execute({ ...v4, schemaVersion: 3 }, {})).toMatchObject({ outcome: "validation_issue" });
  expect(await handler.execute({ ...v4, payload: { ...payload, publication: { ...payload.publication,
    operations: [{ op: "set_product_status", productSlug: "example", status: "active" }],
  } } }, {})).toMatchObject({ outcome: "validation_issue" });
  expect(store.apply).toHaveBeenCalledTimes(1);
});
