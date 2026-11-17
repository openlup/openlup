import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalCatalogPriceSetupCommand } from "../../src/pricing/catalogPriceSetupSchemas.js";
import { createCatalogPriceSetupHandler, type CatalogPriceSetupStorePort } from "../../src/pricing/catalogPriceSetupHandler.js";

const variantId = "10000000-0000-4000-8000-000000000001";
const priceListId = "20000000-0000-4000-8000-000000000001";
const actorId = "40000000-0000-4000-8000-000000000001";
const previous = { entryId: "30000000-0000-4000-8000-000000000001", unitPriceMinor: 1000, validFrom: "2026-09-30T10:00:00+00:00" };
const current = { entryId: "30000000-0000-4000-8000-000000000002", unitPriceMinor: 1200, validFrom: "2026-09-30T11:00:00+00:00" };
const command = {
  schemaVersion: 1, commandKey: "change-1", variantId, priceListId, mode: "one_time", minQty: 1,
  amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: previous.entryId, unitPriceMinor: 1000 },
};
const receipt = { commandKey: "change-1", variantId, priceListId, actorId, previous, current };
const preview = {
  outcome: "preview", variantId, priceListId, inGate: true, current, currentCount: 1,
  subscription: { kind: "stored", unitPriceMinor: 1100 }, readiness: { ready: true, reasons: [] },
};
const unavailable = { outcome: "dependency_unavailable", reason: "price_setup_dependency_unavailable" };

function setup() {
  const store = {
    preview: vi.fn<CatalogPriceSetupStorePort["preview"]>().mockResolvedValue(preview),
    apply: vi.fn<CatalogPriceSetupStorePort["apply"]>().mockResolvedValue({ outcome: "committed", receipt }),
  };
  const authorizeOperator = vi.fn().mockResolvedValue({ actorId });
  return { store, authorizeOperator, handler: createCatalogPriceSetupHandler({ store, authorizeOperator }) };
}

describe("catalog price setup use case", () => {
  it("refuses a request without a verified administrator before any store call", async () => {
    const { handler, store, authorizeOperator } = setup();
    authorizeOperator.mockResolvedValue(null);
    const refusal = { outcome: "unauthorized", reason: "operator_required" };
    expect(await handler.preview({ variantId, priceListId }, {})).toEqual(refusal);
    expect(await handler.apply(command, {})).toEqual(refusal);
    expect(await handler.readback({ receipt }, {})).toEqual(refusal);
    authorizeOperator.mockRejectedValue(new Error("private detail"));
    expect(await handler.apply(command, {})).toEqual(unavailable);
    expect(store.preview).not.toHaveBeenCalled();
    expect(store.apply).not.toHaveBeenCalled();
  });

  it("refuses invalid input without a store call", async () => {
    const { handler, store } = setup();
    expect(await handler.apply({ ...command, mode: "subscription" }, {})).toMatchObject({ outcome: "validation_issue" });
    expect(await handler.preview({ variantId, priceListId, unitPriceMinor: 0 }, {})).toMatchObject({ outcome: "validation_issue" });
    expect(await handler.readback({ receipt: { ...receipt, actorId: "someone" } }, {})).toMatchObject({ outcome: "validation_issue" });
    expect(store.apply).not.toHaveBeenCalled();
    expect(store.preview).not.toHaveBeenCalled();
  });

  it("fingerprints the exact canonical bytes and passes committed and replayed receipts through", async () => {
    const { handler, store } = setup();
    const canonical = canonicalCatalogPriceSetupCommand(command);
    expect(await handler.apply(Object.fromEntries(Object.entries(command).reverse()), {}))
      .toEqual({ outcome: "committed", receipt });
    expect(store.apply).toHaveBeenCalledWith({
      canonicalCommand: canonical, fingerprint: createHash("sha256").update(canonical).digest("hex"),
    });
    store.apply.mockResolvedValueOnce({ outcome: "replayed", receipt });
    expect(await handler.apply(command, {})).toEqual({ outcome: "replayed", receipt });
    store.apply.mockResolvedValueOnce({ outcome: "conflict", reason: "command_key_reused" });
    expect(await handler.apply(command, {})).toEqual({ outcome: "conflict", reason: "command_key_reused" });
  });

  it("fails closed on a malformed answer or a receipt for another command or administrator", async () => {
    const { handler, store } = setup();
    for (const answer of [
      { outcome: "committed" },
      { outcome: "committed", receipt: { ...receipt, commandKey: "change-2" } },
      { outcome: "committed", receipt: { ...receipt, actorId: "40000000-0000-4000-8000-000000000002" } },
      { outcome: "replayed", receipt: { ...receipt, current: { ...current, unitPriceMinor: 1300 } } },
    ]) {
      store.apply.mockResolvedValueOnce(answer);
      expect(await handler.apply(command, {})).toEqual(unavailable);
    }
    store.apply.mockRejectedValueOnce(new Error("private driver detail"));
    expect(await handler.apply(command, {})).toEqual(unavailable);
    store.preview.mockResolvedValueOnce({ ...preview, variantId: previous.entryId });
    expect(await handler.preview({ variantId, priceListId }, {})).toEqual(unavailable);
    expect(await handler.preview({ variantId, priceListId, unitPriceMinor: 900 }, {})).toEqual(unavailable);
  });

  it("reads a receipt back as confirmed while its base is effective and diverged after a later change", async () => {
    const { handler, store } = setup();
    expect(await handler.readback({ receipt }, {})).toEqual({ outcome: "confirmed", preview });
    expect(store.preview).toHaveBeenCalledWith({ variantId, priceListId });
    const moved = { ...preview, current: { ...current, entryId: "30000000-0000-4000-8000-000000000003", unitPriceMinor: 1250 } };
    store.preview.mockResolvedValueOnce(moved);
    expect(await handler.readback({ receipt }, {})).toEqual({ outcome: "diverged", preview: moved });
    store.preview.mockResolvedValueOnce({ outcome: "unauthorized", reason: "operator_required" });
    expect(await handler.readback({ receipt }, {})).toEqual({ outcome: "unauthorized", reason: "operator_required" });
  });
});
