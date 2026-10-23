import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { claimInvoiceSellerRevision, createPostgresInvoiceStore } from "../../src/invoicing/index.js";

const seller = { name: "Saved seller", address: { line1: "Example", postalCode: "00000", city: "Example" }, taxIdentifier: { scheme: "host", value: "synthetic" }, bankAccount: null, routingRef: null };
it("refuses missing, unknown, unsupported and invalid host selections before any native claim", async () => {
  const query = vi.fn();
  for (const result of [{ kind: "unknown", code: "unknown" }, { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false }, { kind: "found", seller, revisionRef: "" }] as const) {
    const store = createPostgresInvoiceStore({ query }, { seller: { read: async () => result } });
    expect(await store.claim({ limit: 1, visibilitySeconds: 300, providerRef: "host" })).toMatchObject({ kind: "unsupported" });
  }
  expect(await createPostgresInvoiceStore({ query }).claim({ limit: 1, visibilitySeconds: 300, providerRef: "host" })).toMatchObject({ kind: "unsupported" });
  expect(query).not.toHaveBeenCalled();
  expect(await claimInvoiceSellerRevision(async () => ({ kind: "found", seller, revisionRef: "exact revision" }))).toEqual({ kind: "found", seller, revisionRef: "exact revision" });
});
it("matches every wrapper's required inputs and exact positional order to the pinned SQL", () => {
  const native = readFileSync(new URL("../../../../scripts/fixtures/20261022195000_invoicing_seller_revision.sql", import.meta.url), "utf8");
  const managed = readFileSync(new URL("../../../../scripts/fixtures/20261022195100_invoicing_seller_revision.sql", import.meta.url), "utf8");
  const rows = [
    [native, "invoicing_request_with_seller_policy", ["p_key", "p_source_kind", "p_source_id", "p_order_id", "p_evidence", "p_occurred_at"]],
    [native, "invoicing_claim_with_seller", ["p_limit", "p_visibility", "p_provider", "p_seller", "p_revision", "p_order_id"]],
    [managed, "invoicing_managed_request_with_seller_policy", ["p_key", "p_source_kind", "p_source_id", "p_provider", "p_evidence"]],
    [managed, "invoicing_managed_claim_with_seller", ["p_limit", "p_order", "p_seller", "p_revision"]],
    [managed, "invoicing_managed_claim_corrections_with_seller", ["p_limit", "p_seller", "p_revision"]],
  ] as const;
  for (const [sql, name, required] of rows) {
    const signature = sql.match(new RegExp(`CREATE FUNCTION public\\.${name}\\(([^)]*)\\)`))?.[1];
    expect(signature, name).toBeDefined();
    expect(signature!.split(",").map(parameter => parameter.trim().split(" ")[0]), name).toEqual(required);
  }
});
it("routes native captures and reversals through the pinned eligibility branches with exact evidence order", async () => {
  const query = vi.fn(async () => ({ rows: [{ response: { kind: "missing" } }] }));
  const store = createPostgresInvoiceStore({ query });
  await store.requestReversal({ requestKey: " exact key ", orderId: "order", reason: "order_refunded", proof: { evidenceRef: "proof", fingerprint: "hash", observedAt: "time" } });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("invoicing_request_with_seller_policy($1,$2,$3,$4,$5,$6)"), [" exact key ", "correction", null, "order", { evidenceRef: "proof", fingerprint: "hash", observedAt: "time", reason: "order_refunded" }, null]);
  await store.captureDuty({ requestKey: "capture", sourceKind: "paid", sourceId: "intent", orderId: "order", occurredAt: "time", evidence: { settlementIntentId: "intent", amountMinor: 120, currency: "XXX" } });
  expect(query.mock.calls.at(-1)).toEqual([expect.stringContaining("invoicing_request_with_seller_policy"), ["capture", "paid", "intent", "order", { settlementIntentId: "intent", amountMinor: 120, currency: "XXX" }, "time"]]);
});
