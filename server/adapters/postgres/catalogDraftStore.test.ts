import { describe, expect, it, vi } from "vitest";
import { CatalogDraftStoreError } from "../../../src/domains/catalog/catalogDraftPorts.js";
import { createPostgresCatalogDraftStore } from "./catalogDraftStore.js";

const draftId = "00000000-0000-4000-8000-000000000001";
const productId = "00000000-0000-4000-8000-000000000002";
const record = {
  draftId, productId, revision: 1, status: "open", commandKey: "first",
  fingerprint: "a".repeat(64), actorId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-09-08T10:00:00.000Z",
  payload: { schemaVersion: 1, product: { id: productId, type: { key: "example:item", version: 1 }, dimensions: [] }, skus: [] },
};
const request = { canonicalCommand: JSON.stringify({ commandKey: 'a"b' }), fingerprint: record.fingerprint, actorId: record.actorId };
const { payload: _payload, ...summary } = record;

function probe(result: unknown, error?: { code: string; message: string }) {
  const transport = vi.fn(async () => {
    if (error) throw error;
    return { rows: [{ result }] };
  });
  return { port: createPostgresCatalogDraftStore({ query: transport }), transport };
}

describe("Owner-only catalog draft store", () => {
  it("transports canonical bytes unchanged and returns an immutable receipt", async () => {
    const { port, transport } = probe({ outcome: "committed", record });
    expect(await port.apply(request)).toEqual({ outcome: "committed", record });
    expect(transport).toHaveBeenCalledWith(
      "SELECT public.catalog_draft_apply($1::text, $2::text, $3::text) AS result",
      [request.canonicalCommand, request.fingerprint, request.actorId],
    );
  });

  it("accepts original replay and classified revision conflicts", async () => {
    const original = probe({ outcome: "replayed", record });
    expect(await original.port.apply(request)).toEqual({ outcome: "replayed", record });
    const conflict = { outcome: "conflict", reason: "revision_conflict", currentRevision: 3 };
    expect(await probe(conflict).port.apply(request)).toEqual(conflict);
  });

  it("reads the original command receipt and bounded compact pages", async () => {
    const read = probe(record);
    expect(await read.port.get({ draftId, commandKey: "first" }, record.actorId)).toEqual(record);
    expect(read.transport).toHaveBeenCalledWith(expect.any(String), [draftId, null, "first"]);
    const page = { items: [summary], nextCursor: draftId };
    const list = probe(page);
    expect(await list.port.list({ limit: 1 }, record.actorId)).toEqual(page);
    expect(list.transport).toHaveBeenCalledWith(expect.any(String), [null, 1]);
    expect(await probe(null).port.get({ draftId }, record.actorId)).toBeNull();
  });

  it("rejects malformed responses without pretending a missing dependency is an empty store", async () => {
    expect(await probe({ outcome: "committed", record: { ...record, productId: "invalid" } }).port.apply(request))
      .toEqual({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
    await expect(probe({ items: [], nextCursor: "invalid" }).port.list({ limit: 1 }, record.actorId))
      .rejects.toMatchObject({ refusal: { outcome: "dependency_unavailable" } });
    await expect(probe({}).port.get({ draftId }, record.actorId)).rejects.toBeInstanceOf(CatalogDraftStoreError);
  });

  it("refuses unbounded pages and ambiguous selectors before any database call", async () => {
    const { port, transport } = probe(null);
    for (const limit of [0, 101, 1.5]) {
      await expect(port.list({ limit }, record.actorId)).rejects.toMatchObject({ refusal: { outcome: "validation_issue" } });
    }
    await expect(port.get({ draftId, revision: 1, commandKey: "first" }, record.actorId))
      .rejects.toMatchObject({ refusal: { outcome: "validation_issue" } });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["42501", "unauthorized"], ["22023", "validation_issue"],
    ["23505", "conflict"], ["08006", "dependency_unavailable"],
  ])("classifies %s without exposing database details", async (code, outcome) => {
    const failure = { code, message: "private document and connection detail" };
    const { port } = probe(null, failure);
    const result = await port.apply(request);
    expect(result).toMatchObject({ outcome });
    expect(JSON.stringify(result)).not.toContain(failure.message);
    await expect(port.get({ draftId }, record.actorId)).rejects.toMatchObject({ refusal: { outcome } });
  });
});
