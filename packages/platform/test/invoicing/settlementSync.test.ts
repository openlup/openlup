import { expect, it, vi } from "vitest";
import { syncInvoicePayoutSettlements } from "../../src/invoicing/index.js";
import type { InvoiceSettlementItem, InvoiceSettlementPort } from "../../src/invoicing/contracts/index.js";
import { proof } from "./portFitFixtures.js";

const item: InvoiceSettlementItem = { requestKey: " original:key ", providerRef: "money-a", batchRef: "batch-a", itemRef: "balance-a", providerPaymentRef: "payment-a", paymentIntentRef: null, paymentRef: null, invoiceRef: null, grossMinor: 120, feeMinor: 2, netMinor: 118, currency: "XXX", status: "matched", bankReceivedAt: proof.observedAt, proof };

it("records every distinct item for the same payout/payment and preserves original key bytes, nullable links and replay", async () => {
  const seen = new Set<string>();
  const record = vi.fn<InvoiceSettlementPort["record"]>(async row => {
    const replayed = seen.has(row.itemRef); seen.add(row.itemRef);
    return { kind: "recorded", itemRef: row.itemRef, settlementItemRef: `settlement:${row.itemRef}`, replayed };
  });
  const list = vi.fn(async () => [item, { ...item, itemRef: "balance-b", requestKey: " original:key:b " }, item]);
  const result = await syncInvoicePayoutSettlements({ list, project: row => row, settlement: { record } });
  expect(result).toMatchObject({ checked: 3, recorded: 2, replayed: 1 });
  expect(result.items).toEqual([
    { kind: "recorded", itemRef: "balance-a", settlementItemRef: "settlement:balance-a", replayed: false },
    { kind: "recorded", itemRef: "balance-b", settlementItemRef: "settlement:balance-b", replayed: false },
    { kind: "recorded", itemRef: "balance-a", settlementItemRef: "settlement:balance-a", replayed: true },
  ]);
  expect(list).toHaveBeenCalledWith(10);
  expect(record.mock.calls.map(([row]) => row.itemRef)).toEqual(["balance-a", "balance-b", "balance-a"]);
  expect(record).toHaveBeenNthCalledWith(1, item);
  expect(record.mock.calls[1][0]).toMatchObject({ paymentIntentRef: null, paymentRef: null, invoiceRef: null, providerPaymentRef: "payment-a" });
});

it("never counts unknown/conflicting/unsupported or mismatched receipts as recorded evidence; unavailable reader writes nothing", async () => {
  const record = vi.fn<InvoiceSettlementPort["record"]>();
  for (const result of [
    { kind: "unknown", itemRef: item.itemRef, code: "unknown" },
    { kind: "conflict", itemRef: item.itemRef, code: "money_mismatch" },
    { kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false },
    { kind: "recorded", itemRef: "other-item", settlementItemRef: "row", replayed: false },
  ] as const) {
    record.mockResolvedValueOnce(result);
    await expect(syncInvoicePayoutSettlements({ list: async () => [item], project: row => row, settlement: { record } })).rejects.toThrow();
  }
  record.mockClear();
  await expect(syncInvoicePayoutSettlements({ list: async () => { throw new Error("unavailable"); }, project: () => item, settlement: { record } })).rejects.toThrow("unavailable");
  expect(record).not.toHaveBeenCalled();
  record.mockReset();
  record.mockImplementation(async row => ({ kind: "recorded", itemRef: row.itemRef, settlementItemRef: "collapsed-row", replayed: false }));
  const result = await syncInvoicePayoutSettlements({
    list: async () => [item, { ...item, itemRef: "balance-b", requestKey: "key-b" }, item], project: row => row, settlement: { record },
  });
  expect(result.items).toEqual([
    { kind: "recorded", itemRef: item.itemRef, settlementItemRef: "collapsed-row", replayed: false },
    { kind: "conflict", itemRef: "balance-b", code: "identity_mismatch" },
    { kind: "recorded", itemRef: item.itemRef, settlementItemRef: "collapsed-row", replayed: false },
  ]);
  expect(result).toMatchObject({ checked: 3, recorded: 2, replayed: 0 });
  expect(record).toHaveBeenCalledTimes(3);
  for (const scope of [{ providerRef: "other" }, { batchRef: "other" }, { providerPaymentRef: "other" }]) {
    const scoped = await syncInvoicePayoutSettlements({ list: async () => [item, { ...item, ...scope }], project: row => row, settlement: { record } });
    expect(scoped.items[1]).toEqual({ kind: "conflict", itemRef: item.itemRef, code: "identity_mismatch" });
  }
});
