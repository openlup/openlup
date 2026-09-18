import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runOmnipackReconciliationWorker,
  type OmnipackReconciliationFulfilment,
  type OmnipackReconciliationPort,
  type OmnipackReconciliationProvider,
} from "./omnipackReconciliationWorker.js";
import { OmnipackReconciliationWriteError } from "./omnipackReconciliationError.js";
import { AccountingInvoicePersistenceError } from "../../../src/domains/accounting/ports.js";

const DISPATCH = {
  dispatchRefId: "ref-1",
  fulfillmentOrderId: "ful-1",
  orderId: "order-1",
  providerOrderId: "provider-order-1",
};

describe("OmniPack reconciliation worker", () => {
  it("records SHIPPING as in_transit with tracking, handover, and DB read-backs", async () => {
    const port = fakePort();
    const provider = fakeProvider([
      fulfilment({
        status: "SHIPPING",
        subStatus: null,
        trackingNumbers: ["TRK-1", "TRK-2", "TRK-1"],
        trackingReferences: [
          {
            trackingNumber: "TRK-1",
            trackingUrl: "https://inpost.example/track/TRK-1",
            carrierKind: "inpost",
            service: "INPOST_PACZKOMAT",
          },
        ],
      }),
    ]);

    await expect(runOmnipackReconciliationWorker({ port, provider, batchSize: 50, page: 2 })).resolves.toMatchObject({
      ok: true,
      checked: 1,
      updated: 1,
      trackingRefs: 2,
      readBacks: 2,
      providerCalls: 1,
    });
    expect(provider.getFulfilments).toHaveBeenCalledWith({ page: 2, size: 50 });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "omnipack-reconciliation:ful-1:shipping:2026-06-10T09:00:00+00:00",
      providerStatus: "shipping",
      localStatus: "in_transit",
      occurredAt: "2026-06-10T09:00:00+00:00",
    }));
    expect(port.recordTrackingReference).toHaveBeenCalledTimes(2);
    expect(port.markHandedOver).toHaveBeenCalledWith({
      idempotencyKey: "omnipack-reconciliation:ful-1:handoff",
      fulfillmentOrderId: "ful-1",
      suppressDispatched: false,
    });
    expect(port.markProviderStockConsumed).toHaveBeenCalledWith({
      idempotencyKey: "omnipack-reconciliation:ful-1:provider-stock-consumed",
      fulfillmentOrderId: "ful-1",
    });
    expect(vi.mocked(port.markProviderStockConsumed).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.markHandedOver).mock.invocationCallOrder[0]);
    expect(vi.mocked(port.acknowledgeDispatchAcceptance).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.recordStatusEvidence).mock.invocationCallOrder[0]);
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "omnipack-reconciliation:FUL-1001:openlup-order-1001:shipping:tracking:TRK-1",
      trackingNumber: "TRK-1",
      status: "in_transit",
      rawEvent: expect.objectContaining({ occurredAt: "2026-06-10T09:00:00+00:00" }),
    }));
  });

  it("consumes stock without handover for AWAITING_COURIER (packed, not shipped)", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({ issueAccountingInvoice });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "AWAITING_COURIER", subStatus: "READY_FOR_PICKUP", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ updated: 1, trackingRefs: 0 });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "awaiting_courier",
      providerSubStatus: "READY_FOR_PICKUP",
      localStatus: "packed",
    }));
    expect(port.markProviderStockConsumed).toHaveBeenCalled();
    expect(port.markHandedOver).not.toHaveBeenCalled();
    expect(issueAccountingInvoice).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
  });

  it("consumes stock without handover for READY_FOR_PACKING (finished-picking parity with order.picked webhook)", async () => {
    const port = fakePort();

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "READY_FOR_PACKING", subStatus: "PICKED", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ updated: 1, trackingRefs: 0 });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      providerStatus: "ready_for_packing",
      localStatus: "packed",
    }));
    expect(port.markProviderStockConsumed).toHaveBeenCalled();
    expect(port.markHandedOver).not.toHaveBeenCalled();
  });

  it("quarantines a known fulfillment state conflict and continues the batch", async () => {
    const markProviderStockConsumed = vi.fn()
      .mockRejectedValueOnce(new OmnipackReconciliationWriteError(
        "provider_stock_consumed",
        "22023",
        "commerce_fulfillment_provider_stock_consumed_requires_label",
      ))
      .mockResolvedValue({ status: "packed", replayed: false });
    const port = fakePort({ markProviderStockConsumed });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([
        fulfilment({ orderNumber: "openlup-order-conflict", status: "AWAITING_COURIER", trackingNumbers: [] }),
        fulfilment({ orderNumber: "openlup-order-good", status: "AWAITING_COURIER", trackingNumbers: [] }),
      ]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: true,
      checked: 2,
      stateConflicts: 1,
      quarantined: 1,
      failures: 0,
    });

    expect(markProviderStockConsumed).toHaveBeenCalledTimes(2);
    expect(port.recordQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringContaining("state-conflict:commerce_fulfillment_provider_stock_consumed_requires_label"),
      reason: "omnipack_reconciliation_state_conflict:commerce_fulfillment_provider_stock_consumed_requires_label",
    }));
  });

  it("keeps invalid provider-stock input as a hard job failure", async () => {
    const port = fakePort({
      markProviderStockConsumed: vi.fn(async () => {
        throw new OmnipackReconciliationWriteError(
          "provider_stock_consumed",
          "22023",
          "commerce_fulfillment_provider_stock_consumed_invalid_input",
        );
      }),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "AWAITING_COURIER", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: false,
      stateConflicts: 0,
      failures: 1,
      reason: expect.stringContaining("invalid_input"),
    });
    expect(port.recordQuarantine).not.toHaveBeenCalled();
  });

  it("keeps NEW / IN_FULFILLMENT evidence-only (no stock, no handover, no hold)", async () => {
    for (const [status, expectedLocal] of [["NEW", "provider_received"], ["IN_FULFILLMENT", "picking"]] as const) {
      const port = fakePort();
      await runOmnipackReconciliationWorker({
        port,
        provider: fakeProvider([fulfilment({ status, subStatus: "EXPORTED", trackingNumbers: [] })]),
        batchSize: 50,
      });
      expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({ localStatus: expectedLocal }));
      expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
      expect(port.markHandedOver).not.toHaveBeenCalled();
      expect(port.recordProviderException).not.toHaveBeenCalled();
    }
  });

  it("records DELIVERED tracking events without customer email or inventory ports", async () => {
    const port = fakePort();
    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", subStatus: null, trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    });

    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({ status: "delivered" }));
    expect(port.markHandedOver).toHaveBeenCalledWith(expect.objectContaining({ suppressDispatched: true }));
    expect(JSON.stringify(port)).not.toContain("inventory");
    expect(JSON.stringify(port)).not.toContain("email");
  });

  it("quarantines fulfilments with no matching dispatch ref", async () => {
    const port = fakePort({ findDispatchRef: vi.fn(async () => null) });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING" })]),
      batchSize: 50,
    })).resolves.toMatchObject({ quarantined: 1, updated: 0, trackingRefs: 0 });

    expect(port.recordQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      reason: "omnipack_dispatch_ref_not_found",
    }));
    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
  });

  it("ignores stale status evidence", async () => {
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => "2026-06-11T09:00:00+00:00"),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", updatedAt: "2026-06-10T09:00:00+00:00" })]),
      batchSize: 50,
    })).resolves.toMatchObject({ stale: 1, updated: 0, trackingRefs: 0 });

    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
    expect(port.recordProviderException).not.toHaveBeenCalled();
    expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
    expect(port.markHandedOver).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
  });

  it("records A to B to A as three occurrences and replays the exact final occurrence", async () => {
    const evidenceKeys = new Set<string>();
    let latest: string | null = null;
    const recordStatusEvidence = vi.fn(async (input: {
      idempotencyKey: string;
      occurredAt: string | null;
    }) => {
      const replayed = evidenceKeys.has(input.idempotencyKey);
      evidenceKeys.add(input.idempotencyKey);
      if (!replayed && input.occurredAt) latest = input.occurredAt;
      return { replayed };
    });
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => latest),
      recordStatusEvidence,
    });
    const occurrences = [
      fulfilment({ status: "NEW", updatedAt: " 2026-06-10T09:00:00+00:00 " }),
      fulfilment({ status: "IN_FULFILLMENT", updatedAt: "2026-06-10T10:00:00+00:00" }),
      fulfilment({ status: "NEW", updatedAt: "2026-06-10T11:00:00+00:00" }),
    ];

    for (const occurrence of occurrences) {
      await expect(runOmnipackReconciliationWorker({
        port,
        provider: fakeProvider([occurrence]),
        batchSize: 50,
      })).resolves.toMatchObject({ updated: 1, replayed: 0 });
    }
    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([occurrences[2]]),
      batchSize: 50,
    })).resolves.toMatchObject({ updated: 0, replayed: 1 });

    expect([...evidenceKeys]).toEqual([
      "omnipack-reconciliation:ful-1:new:2026-06-10T09:00:00+00:00",
      "omnipack-reconciliation:ful-1:in_fulfillment:2026-06-10T10:00:00+00:00",
      "omnipack-reconciliation:ful-1:new:2026-06-10T11:00:00+00:00",
    ]);
    expect(recordStatusEvidence).toHaveBeenCalledTimes(4);
  });

  it("uses the provider occurrence for exception idempotency and replays an exact retry", async () => {
    const evidenceKeys = new Set<string>();
    const exceptionKeys = new Set<string>();
    const port = fakePort({
      recordStatusEvidence: vi.fn(async ({ idempotencyKey }) => {
        const replayed = evidenceKeys.has(idempotencyKey);
        evidenceKeys.add(idempotencyKey);
        return { replayed };
      }),
      recordProviderException: vi.fn(async ({ idempotencyKey }) => {
        const replayed = exceptionKeys.has(idempotencyKey);
        exceptionKeys.add(idempotencyKey);
        return { replayed };
      }),
    });
    const occurrence = fulfilment({
      status: "CANCELLED",
      updatedAt: " 2026-06-10T12:00:00+00:00 ",
      trackingNumbers: [],
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([occurrence]),
      batchSize: 50,
    })).resolves.toMatchObject({ updated: 1, exceptions: 1, replayed: 0 });
    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([occurrence]),
      batchSize: 50,
    })).resolves.toMatchObject({ updated: 0, exceptions: 0, replayed: 2 });

    expect([...evidenceKeys]).toEqual([
      "omnipack-reconciliation:ful-1:cancelled:2026-06-10T12:00:00+00:00",
    ]);
    expect([...exceptionKeys]).toEqual([
      "omnipack-reconciliation:ful-1:cancelled:2026-06-10T12:00:00+00:00:exception",
    ]);
  });

  it("uses unknown-time when the provider supplies no non-blank occurrence time", async () => {
    const port = fakePort();

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "NEW", updatedAt: " ", createdAt: "" })]),
      batchSize: 50,
    });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "omnipack-reconciliation:ful-1:new:unknown-time",
      occurredAt: null,
    }));
  });

  it("records distinct SHIPPING snapshot revisions while durable physical-effect keys replay", async () => {
    // Provider `updatedAt` is a resource/snapshot revision, not proven status
    // transition time. This in-memory durable seam models the existing effect
    // ports: a newer same-status snapshot records new evidence but replays the
    // stable physical effects.
    const durableKeys = {
      stock: new Set<string>(),
      handoff: new Set<string>(),
      tracking: new Set<string>(),
      invoice: new Set<string>(),
    };
    const invoiceReplayResults: boolean[] = [];
    const replayedPhysicalEffect = <T extends object>(keys: Set<string>, idempotencyKey: string, value: T) => {
      const replayed = keys.has(idempotencyKey);
      keys.add(idempotencyKey);
      return { ...value, replayed };
    };
    const issueAccountingInvoice = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      const replayed = durableKeys.invoice.has(idempotencyKey);
      durableKeys.invoice.add(idempotencyKey);
      invoiceReplayResults.push(replayed);
    });
    const port = fakePort({
      markProviderStockConsumed: vi.fn(async ({ idempotencyKey }) => replayedPhysicalEffect(
        durableKeys.stock, idempotencyKey, { status: "packed" as const },
      )),
      markHandedOver: vi.fn(async ({ idempotencyKey }) => replayedPhysicalEffect(
        durableKeys.handoff, idempotencyKey, { status: "handed_over" as const },
      )),
      recordTrackingReference: vi.fn(async ({ idempotencyKey }) => replayedPhysicalEffect(
        durableKeys.tracking, idempotencyKey, { readBack: true },
      )),
      issueAccountingInvoice,
    });
    const revisions = ["2026-06-10T09:00:00+00:00", "2026-06-10T10:00:00+00:00"] as const;
    const snapshots = revisions.map((updatedAt) => fulfilment({
      status: "SHIPPING", updatedAt, trackingNumbers: ["TRK-REVISION"],
    }));

    await expect(runOmnipackReconciliationWorker({
      port, provider: fakeProvider([snapshots[0]]), batchSize: 50,
    })).resolves.toMatchObject({ updated: 1, trackingRefs: 1, replayed: 0 });
    await expect(runOmnipackReconciliationWorker({
      port, provider: fakeProvider([snapshots[1]]), batchSize: 50,
    })).resolves.toMatchObject({ updated: 1, trackingRefs: 0, replayed: 3 });

    const evidenceKeys = vi.mocked(port.recordStatusEvidence).mock.calls.map(([input]) => input.idempotencyKey);
    expect(evidenceKeys).toHaveLength(2);
    expect(evidenceKeys[0]).toContain(revisions[0]);
    expect(evidenceKeys[1]).toContain(revisions[1]);
    expect(new Set(evidenceKeys).size).toBe(2);

    const stableEffectKeyGroups = [
      vi.mocked(port.markProviderStockConsumed).mock.calls.map(([input]) => input.idempotencyKey),
      vi.mocked(port.markHandedOver).mock.calls.map(([input]) => input.idempotencyKey),
      vi.mocked(port.recordTrackingReference).mock.calls.map(([input]) => input.idempotencyKey),
      issueAccountingInvoice.mock.calls.map(([input]) => input.idempotencyKey),
    ];
    for (const keys of stableEffectKeyGroups) {
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(1);
    }
    expect(invoiceReplayResults).toEqual([false, true]);
  });

  it("never treats fulfillment creation time as delivery occurrence time", async () => {
    const port = fakePort();

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({
        status: "DELIVERED",
        updatedAt: null,
        createdAt: "2026-06-01T08:00:00+00:00",
      })]),
      batchSize: 50,
    });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "omnipack-reconciliation:ful-1:delivered:unknown-time",
      occurredAt: null,
      sanitizedPayload: expect.objectContaining({ occurredAt: null }),
    }));
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      rawEvent: expect.objectContaining({ occurredAt: null }),
    }));
  });

  it("recovers a missing invoice from stale provider exception evidence when handoff is already durable", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => "2026-06-11T09:00:00+00:00"),
      readHandedOverAt: vi.fn(async () => "2026-06-10T10:00:00+00:00"),
      issueAccountingInvoice,
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "CANCELLED", updatedAt: "2026-06-10T09:00:00+00:00" })]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, stale: 1, updated: 0, trackingRefs: 0 });

    expect(port.readHandedOverAt).toHaveBeenCalledWith("ful-1");
    expect(issueAccountingInvoice).toHaveBeenCalledWith({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
    });
    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
    expect(port.recordProviderException).not.toHaveBeenCalled();
    expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
    expect(port.markHandedOver).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
  });

  it("does not recover an invoice from stale shipped evidence before durable handoff", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => "2026-06-11T09:00:00+00:00"),
      readHandedOverAt: vi.fn(async () => null),
      issueAccountingInvoice,
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", updatedAt: "2026-06-10T09:00:00+00:00" })]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, stale: 1, updated: 0, trackingRefs: 0 });

    expect(port.readHandedOverAt).toHaveBeenCalledWith("ful-1");
    expect(issueAccountingInvoice).not.toHaveBeenCalled();
  });

  it("fails stale handoff recovery visibly and retries the same invoice request on the next pull", async () => {
    const issueAccountingInvoice = vi.fn()
      .mockRejectedValueOnce(new Error("invoice_request_unavailable"))
      .mockResolvedValueOnce(undefined);
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => "2026-06-11T09:00:00+00:00"),
      readHandedOverAt: vi.fn(async () => "2026-06-10T10:00:00+00:00"),
      issueAccountingInvoice,
    });
    const input = {
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", updatedAt: "2026-06-10T09:00:00+00:00" })]),
      batchSize: 50,
    };

    await expect(runOmnipackReconciliationWorker(input)).resolves.toMatchObject({
      ok: false,
      failures: 1,
      invoiceIssueFailures: 1,
    });
    await expect(runOmnipackReconciliationWorker(input)).resolves.toMatchObject({
      ok: true,
      failures: 0,
      invoiceIssueFailures: 0,
    });

    expect(issueAccountingInvoice).toHaveBeenCalledTimes(2);
    expect(issueAccountingInvoice).toHaveBeenNthCalledWith(2, {
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
    });
  });

  // The stale branch is a SECOND call site for the invoice helper, reached when
  // the provider timestamp lags the newest local status evidence. The refusal
  // has to survive it too, or a parcel whose provider clock is behind still
  // freezes the run and starves every other page.
  it("counts a permanent refusal recovered from stale evidence without failing the run", async () => {
    const issueAccountingInvoice = vi.fn(async () => {
      throw refusal("accounting_invoice_payment_not_succeeded");
    });
    const port = fakePort({
      latestStatusOccurredAt: vi.fn(async () => "2026-06-11T09:00:00+00:00"),
      readHandedOverAt: vi.fn(async () => "2026-06-10T10:00:00+00:00"),
      issueAccountingInvoice,
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", updatedAt: "2026-06-10T09:00:00+00:00" })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: true,
      stale: 1,
      updated: 0,
      failures: 0,
      invoiceIssueFailures: 0,
      invoiceIssueRefused: 1,
      invoiceIssueRefusals: [{
        fulfillmentOrderId: "ful-1",
        identifier: "accounting_invoice_payment_not_succeeded",
        sqlstate: "22023",
        benign: false,
      }],
    });

    expect(issueAccountingInvoice).toHaveBeenCalledOnce();
    // Same p1-for-p1 trap as the effects path: a refusal is counted, never
    // quarantined.
    expect(port.recordQuarantine).not.toHaveBeenCalled();
  });

  it("places an ops hold for SUSPENDED / SHIPPING_FAILED / RETURNED_TO_SENDER without stock, handoff, or tracking", async () => {
    for (const status of ["SUSPENDED", "SHIPPING_FAILED", "RETURNED_TO_SENDER"] as const) {
      const port = fakePort();

      await expect(runOmnipackReconciliationWorker({
        port,
        provider: fakeProvider([fulfilment({ status, subStatus: status === "SUSPENDED" ? "OUT_OF_STOCK" : null, trackingNumbers: [] })]),
        batchSize: 50,
      })).resolves.toMatchObject({ exceptions: 1, trackingRefs: 0 });

      expect(port.recordProviderException).toHaveBeenCalledWith(expect.objectContaining({
        orderId: "order-1",
        fulfillmentOrderId: "ful-1",
        reason: status,
      }));
      expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({ localStatus: "exception" }));
      // exception is terminal-for-this-pass: no stock consume, handover, or tracking.
      expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
      expect(port.markHandedOver).not.toHaveBeenCalled();
      expect(port.recordTrackingReference).not.toHaveBeenCalled();
    }
  });

  it("preserves every vendor-confirmed SUSPENDED sub-status without independent effects", async () => {
    const vendorConfirmedSubStatuses = [
      "OUT_OF_STOCK",
      "NO_SKU",
      "ADDR_ERROR",
      "CARRIER_MAPPING_ERROR",
      "MERCH_BLOCKED",
      "NO_MATERIALS",
      "ERROR",
    ];

    for (const providerSubStatus of vendorConfirmedSubStatuses) {
      const issueAccountingInvoice = vi.fn(async () => undefined);
      const port = fakePort({ issueAccountingInvoice });
      await expect(runOmnipackReconciliationWorker({
        port,
        provider: fakeProvider([fulfilment({ status: "SUSPENDED", subStatus: providerSubStatus, trackingNumbers: [] })]),
        batchSize: 50,
      })).resolves.toMatchObject({ exceptions: 1, trackingRefs: 0 });

      expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
        providerSubStatus,
        localStatus: "exception",
      }));
      expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
      expect(port.markHandedOver).not.toHaveBeenCalled();
      expect(port.recordTrackingReference).not.toHaveBeenCalled();
      expect(issueAccountingInvoice).not.toHaveBeenCalled();
    }
  });

  it("places provider CANCELLED on an ops hold without cancelling locally or changing stock/handoff/tracking", async () => {
    const port = fakePort();
    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "CANCELLED", subStatus: null, trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ exceptions: 1, trackingRefs: 0 });

    expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({ localStatus: "exception" }));
    expect(port.recordProviderException).toHaveBeenCalledWith(expect.objectContaining({
      orderId: "order-1",
      fulfillmentOrderId: "ful-1",
      reason: "CANCELLED",
      // The occurrence travels with the hold so an auto-released hold can still
      // say which observation opened it. `reason` keeps provider casing;
      // providerStatus is the normalized token.
      providerStatus: "cancelled",
      occurredAt: "2026-06-10T09:00:00+00:00",
    }));
    expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
    expect(port.markHandedOver).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).not.toHaveBeenCalled();
    expect(port.readHandedOverAt).not.toHaveBeenCalled();
  });

  it("idempotently requests the invoice after an exception when handoff is already durable", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({
      readHandedOverAt: vi.fn(async () => "2026-06-10T10:00:00+00:00"),
      issueAccountingInvoice,
      recordProviderException: vi.fn(async () => ({ replayed: true })),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "CANCELLED", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, replayed: 1, exceptions: 0 });

    expect(port.readHandedOverAt).toHaveBeenCalledWith("ful-1");
    expect(issueAccountingInvoice).toHaveBeenCalledWith({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
    });
    expect(vi.mocked(port.recordProviderException).mock.invocationCallOrder[0])
      .toBeLessThan(issueAccountingInvoice.mock.invocationCallOrder[0]);
  });

  it("does not request an invoice for an exception before durable handoff", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({ issueAccountingInvoice });

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "CANCELLED", trackingNumbers: [] })]),
      batchSize: 50,
    });

    expect(port.readHandedOverAt).toHaveBeenCalledWith("ful-1");
    expect(issueAccountingInvoice).not.toHaveBeenCalled();
  });

  it("maps every dictionary status; only UNKNOWN quarantines", async () => {
    // Coverage from the API-status dictionary. Each status is exercised in
    // UPPER_SNAKE and lowercase spelling — the pre-fix worker matched a guessed
    // vocabulary and silently skipped everything (0 evidence rows ever).
    const dictionary = JSON.parse(
      readFileSync(join(__dirname, "../../../config/omnipack-status-dictionary.json"), "utf8"),
    ) as { statuses: Array<{ status: string; localStatus: string | null }> };

    const mapped = dictionary.statuses.filter((entry) => entry.localStatus !== null);
    expect(mapped.length).toBeGreaterThanOrEqual(9);

    for (const entry of mapped) {
      for (const spell of [(v: string) => v, (v: string) => v.toLowerCase()]) {
        const port = fakePort();
        await expect(runOmnipackReconciliationWorker({
          port,
          provider: fakeProvider([fulfilment({ status: spell(entry.status), subStatus: null, trackingNumbers: [] })]),
          batchSize: 50,
        })).resolves.toMatchObject({ ok: true, quarantined: 0 });

        expect(port.recordQuarantine).not.toHaveBeenCalled();
        expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
          localStatus: entry.localStatus,
        }));
      }
    }

    // UNKNOWN (documented exceptional) quarantines, does not map.
    const unknownPort = fakePort();
    await expect(runOmnipackReconciliationWorker({
      port: unknownPort,
      provider: fakeProvider([fulfilment({ status: "UNKNOWN", subStatus: null, trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ quarantined: 1, updated: 0 });
    expect(unknownPort.recordQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      reason: "omnipack_unknown_provider_status",
    }));
  });

  it("acknowledges provider acceptance before quarantining an unknown primary status", async () => {
    const port = fakePort();

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "Some brand new state", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ quarantined: 1, updated: 0 });

    expect(port.recordQuarantine).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "omnipack-reconciliation:FUL-1001:openlup-order-1001:unknown-status:some_brand_new_state",
      reason: "omnipack_unknown_provider_status",
    }));
    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
    expect(port.findDispatchRef).toHaveBeenCalledOnce();
    expect(port.acknowledgeDispatchAcceptance).toHaveBeenCalledOnce();
  });

  it("fills carrier + tracking URL from the local delivery selection when the feed has bare numbers (live prod gap)", async () => {
    // OPENLUP-0F50280B (2026-07-13): the feed returned only the tracking number;
    // shipment_external_refs got carrier_kind=null / tracking_url=null and the
    // customer email showed a bare number.
    const port = fakePort({
      readDeliveryCarrier: vi.fn(async () => ({ carrierKind: "inpost", service: "inpost_locker_standard" })),
    });

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", trackingNumbers: ["620999680605074433453432"] })]),
      batchSize: 50,
    });

    expect(port.readDeliveryCarrier).toHaveBeenCalledWith("ful-1");
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      trackingNumber: "620999680605074433453432",
      carrierKind: "inpost",
      service: "inpost_locker_standard",
      trackingUrl: "https://inpost.pl/sledzenie-przesylek?number=620999680605074433453432",
    }));
  });

  it("does not consult the local delivery selection when the feed ref is already complete", async () => {
    const port = fakePort();

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({
        status: "SHIPPING",
        trackingNumbers: [],
        trackingReferences: [{
          trackingNumber: "TRK-FULL",
          trackingUrl: "https://inpost.example/track/TRK-FULL",
          carrierKind: "inpost",
          service: "INPOST_PACZKOMAT",
        }],
      })]),
      batchSize: 50,
    });

    expect(port.readDeliveryCarrier).not.toHaveBeenCalled();
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      trackingUrl: "https://inpost.example/track/TRK-FULL",
      carrierKind: "inpost",
    }));
  });

  it("keeps nulls when neither the feed nor the local selection knows the carrier", async () => {
    const port = fakePort();

    await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", trackingNumbers: ["TRK-BARE"] })]),
      batchSize: 50,
    });

    expect(port.readDeliveryCarrier).toHaveBeenCalledTimes(1);
    expect(port.recordTrackingReference).toHaveBeenCalledWith(expect.objectContaining({
      trackingNumber: "TRK-BARE",
      carrierKind: null,
      service: null,
      trackingUrl: null,
    }));
  });

  it("counts replayed status and tracking idempotency", async () => {
    const port = fakePort({
      recordStatusEvidence: vi.fn(async () => ({ replayed: true })),
      recordTrackingReference: vi.fn(async () => ({ replayed: true, readBack: true })),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ replayed: 2, updated: 0, trackingRefs: 0, readBacks: 1 });
  });

  it("requests one accounting invoice after durable handoff and tracking, including on replay", async () => {
    const issueAccountingInvoice = vi.fn(async () => undefined);
    const port = fakePort({
      issueAccountingInvoice,
      markHandedOver: vi.fn(async () => ({ status: "handed_over", replayed: true })),
      recordTrackingReference: vi.fn(async () => ({ replayed: true, readBack: true })),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: true,
      invoiceIssueFailures: 0,
    });

    expect(issueAccountingInvoice).toHaveBeenCalledWith({
      idempotencyKey: "omnipack:webhook:ful-1:accounting-invoice",
      fulfillmentOrderId: "ful-1",
    });
    expect(vi.mocked(port.markHandedOver).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(port.recordTrackingReference).mock.invocationCallOrder[0]);
    expect(vi.mocked(port.recordTrackingReference).mock.invocationCallOrder[0])
      .toBeLessThan(issueAccountingInvoice.mock.invocationCallOrder[0]);
  });

  it("preserves fulfillment and tracking but fails the run for accounting retry evidence", async () => {
    const issueAccountingInvoice = vi.fn(async () => {
      throw new Error("invoice_request_unavailable");
    });
    const port = fakePort({ issueAccountingInvoice });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: false,
      updated: 1,
      trackingRefs: 1,
      readBacks: 1,
      failures: 1,
      invoiceIssueFailures: 1,
      reason: "omnipack_reconciliation_accounting_invoice_issue_failed:invoice_request_unavailable",
    });

    expect(port.markHandedOver).toHaveBeenCalledOnce();
    expect(port.recordTrackingReference).toHaveBeenCalledOnce();
    expect(issueAccountingInvoice).toHaveBeenCalledOnce();
  });

  // historical failure mode 2026-09-09 -> 2026-09-10: a partial refund on an
  // already-invoiced order moved its only payment intent out of `succeeded`, so
  // the accounting RPC refused with SQLSTATE 22023 on every replay, forever.
  // Counted as a run failure it returned 502, wrote the ledger row `failed` and
  // froze the pagination checkpoint on its own page: two of three pages went
  // unscanned for 21+ hours and seven delivered parcels stayed durably in
  // transit. A permanent refusal is one fulfilment's fact, not the run's.
  it("counts a permanent accounting refusal instead of failing the run, and keeps the durable effects", async () => {
    const issueAccountingInvoice = vi.fn(async () => {
      throw refusal("accounting_invoice_payment_not_succeeded");
    });
    const port = fakePort({ issueAccountingInvoice });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: true,
      updated: 1,
      trackingRefs: 1,
      readBacks: 1,
      failures: 0,
      invoiceIssueFailures: 0,
      invoiceIssueRefused: 1,
      invoiceIssueRefusals: [{
        fulfillmentOrderId: "ful-1",
        identifier: "accounting_invoice_payment_not_succeeded",
        sqlstate: "22023",
        benign: false,
      }],
      // Its own prefix: a refusal and a failure must not read the same in
      // platform_job_runs, because one is a fulfilment fact and one is a run fault.
      reason: "omnipack_reconciliation_accounting_invoice_issue_refused:Accounting invoice issue request failed: accounting_invoice_payment_not_succeeded (22023)",
    });

    // The refused parcel needs no repair: markHandedOver commits first and the
    // invoice call runs last (omnipackStatusVocabulary.ts:218-222, :239).
    expect(port.markHandedOver).toHaveBeenCalledOnce();
    expect(port.recordTrackingReference).toHaveBeenCalledOnce();
    // The p1-for-p1 trap again: a quarantine writes inbound_provider_events with
    // processing_status='ignored', which feeds two p1 monitors. A refusal is
    // counted and itemised instead.
    expect(port.recordQuarantine).not.toHaveBeenCalled();
  });

  it("marks a deleted-row refusal benign so a cleanup orphan cannot read like a refund refusal", async () => {
    const port = fakePort({
      issueAccountingInvoice: vi.fn(async () => { throw refusal("accounting_invoice_handoff_not_found"); }),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: true,
      failures: 0,
      invoiceIssueRefused: 1,
      invoiceIssueRefusals: [{
        fulfillmentOrderId: "ful-1",
        identifier: "accounting_invoice_handoff_not_found",
        sqlstate: "22023",
        benign: true,
      }],
    });
  });

  // The classification is deliberately narrower than the outbox twin's: 23514 is
  // the provider-immutability check and fires for every invoiced order whenever
  // the runtime asks for a different provider than the invoice was created with,
  // i.e. a fleet-wide configuration fault. Any other SQLSTATE is unclassified.
  // Both stay a loud run failure, byte for byte as before this wave.
  it.each([
    { name: "the provider-immutability check", code: "23514", identifier: "accounting_invoice_provider_mismatch" },
    { name: "an unclassified backend refusal", code: "40001", identifier: "accounting_invoice_issue_request_conflict" },
  ])("still fails the run for $name", async ({ code, identifier }) => {
    const port = fakePort({
      issueAccountingInvoice: vi.fn(async () => {
        throw new AccountingInvoicePersistenceError(PERSISTENCE_MESSAGE, code, identifier);
      }),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "DELIVERED", trackingNumbers: ["TRK-1"] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: false,
      updated: 1,
      failures: 1,
      invoiceIssueFailures: 1,
      invoiceIssueRefused: 0,
      invoiceIssueRefusals: [],
      reason: `omnipack_reconciliation_accounting_invoice_issue_failed:${PERSISTENCE_MESSAGE}: ${identifier} (${code})`,
    });
  });

  it("reconciles the whole page through refusals and itemises at most ten of them", async () => {
    let dispatched = 0;
    const issueAccountingInvoice = vi.fn(async () => {
      throw refusal("accounting_invoice_payment_not_succeeded");
    });
    const port = fakePort({
      findDispatchRef: vi.fn(async () => {
        dispatched += 1;
        return { ...DISPATCH, fulfillmentOrderId: `ful-${dispatched}` };
      }),
      issueAccountingInvoice,
    });

    const result = await runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider(Array.from({ length: 11 }, (_unused, index) => fulfilment({
        fulfilmentNumber: `FUL-${index}`,
        status: "DELIVERED",
        trackingNumbers: [`TRK-${index}`],
      }))),
      batchSize: 50,
    });

    expect(result).toMatchObject({ ok: true, checked: 11, updated: 11, failures: 0, invoiceIssueRefused: 11 });
    // Bounded itemisation, unbounded counter: one bad page must not grow the
    // jsonb column, and the eleventh refusal is still counted.
    expect(result.invoiceIssueRefusals).toHaveLength(10);
    expect(result.invoiceIssueRefusals.at(-1)?.fulfillmentOrderId).toBe("ful-10");
    expect(issueAccountingInvoice).toHaveBeenCalledTimes(11);
  });

  // historical failure mode 2026-07-17 → 2026-07-18: a cancelled synthetic order
  // (OPENLUP-433F84FA) left a live dispatch ref, OmniPack kept returning the
  // fulfilment, and the acceptance ack raised 22023 on every 15-min run — the
  // job reported `failed` for ~1.3 days and paged ntfy every ~4h.
  it.each(["cancelled", "exception"])(
    "skips convergence for a %s local fulfillment benignly instead of failing the job",
    async (localStatus) => {
      const port = fakePort({ readLocalFulfillmentStatus: vi.fn(async () => localStatus) });

      await expect(runOmnipackReconciliationWorker({
        port,
        provider: fakeProvider([fulfilment({ status: "SHIPPING" })]),
        batchSize: 50,
      })).resolves.toMatchObject({
        ok: true,
        checked: 1,
        offTrackSkips: 1,
        failures: 0,
        // `updated` counts CONVERGED fulfilments; the evidence row below is not
        // convergence, and the off-track row is already counted once above.
        updated: 0,
      });

      // The ack is what raises 22023 — it must never be attempted.
      expect(port.acknowledgeDispatchAcceptance).not.toHaveBeenCalled();
      // The p1-for-p1 trap: quarantining writes inbound_provider_events
      // (processing_status='ignored'), which feeds omnipack_inbound_quarantined
      // AND omnipack_reconciliation_state_conflict — both p1. A benign skip
      // must not touch it at all.
      expect(port.recordQuarantine).not.toHaveBeenCalled();
      expect(port.markProviderStockConsumed).not.toHaveBeenCalled();
      expect(port.markHandedOver).not.toHaveBeenCalled();
      expect(port.recordProviderException).not.toHaveBeenCalled();
      expect(port.recordTrackingReference).not.toHaveBeenCalled();

      // The reason the skip is a flag and not a `continue`: the
      // provider-exception hold healer is an AFTER INSERT trigger on the
      // status-evidence table, so skipping the whole iteration made auto-heal
      // unreachable from the pull path for exactly the orders it exists for.
      // See pgTAP case 11 in provider_exception_hold_auto_heal_test.sql.
      expect(port.recordStatusEvidence).toHaveBeenCalledWith(expect.objectContaining({
        fulfillmentOrderId: "ful-1",
        providerStatus: "shipping",
        localStatus: "in_transit",
      }));
    },
  );

  it("does not quarantine an unknown provider status on an off-track fulfillment", async () => {
    const port = fakePort({ readLocalFulfillmentStatus: vi.fn(async () => "cancelled") });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "PROVIDER_SURPRISE" })]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, offTrackSkips: 1, quarantined: 0, failures: 0 });

    expect(port.recordQuarantine).not.toHaveBeenCalled();
    expect(port.recordStatusEvidence).not.toHaveBeenCalled();
    expect(port.acknowledgeDispatchAcceptance).not.toHaveBeenCalled();
  });

  it("keeps reconciling on-track fulfilments in the same batch as a cancelled one", async () => {
    const port = fakePort({
      readLocalFulfillmentStatus: vi.fn()
        .mockImplementationOnce(async () => "cancelled")
        .mockImplementationOnce(async () => "label_created"),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([
        fulfilment({ fulfilmentNumber: "FUL-CANCELLED", status: "SHIPPING", trackingNumbers: [] }),
        fulfilment({ fulfilmentNumber: "FUL-LIVE", status: "READY_FOR_PACKING", trackingNumbers: [] }),
      ]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, checked: 2, offTrackSkips: 1, updated: 1, failures: 0 });

    expect(port.acknowledgeDispatchAcceptance).toHaveBeenCalledOnce();
  });

  // Guards the other half of the fix: the skip is a positive check on LOCAL
  // state, never a blanket swallow of ack errors. A real provider/DB outage
  // must still turn the job red rather than being masked as benign.
  it("still fails the job when the acceptance ack fails transiently", async () => {
    const port = fakePort({
      acknowledgeDispatchAcceptance: vi.fn(async () => {
        throw new Error("omnipack_reconciliation_dispatch_acknowledgement_failed:08006");
      }),
    });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "SHIPPING", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({
      ok: false,
      failures: 1,
      offTrackSkips: 0,
      reason: expect.stringContaining("08006"),
    });
    expect(port.recordQuarantine).not.toHaveBeenCalled();
  });

  it("reconciles normally when the local fulfillment status is unknown to the canon", async () => {
    const port = fakePort({ readLocalFulfillmentStatus: vi.fn(async () => null) });

    await expect(runOmnipackReconciliationWorker({
      port,
      provider: fakeProvider([fulfilment({ status: "READY_FOR_PACKING", trackingNumbers: [] })]),
      batchSize: 50,
    })).resolves.toMatchObject({ ok: true, offTrackSkips: 0, updated: 1 });

    expect(port.acknowledgeDispatchAcceptance).toHaveBeenCalledOnce();
  });
});

const PERSISTENCE_MESSAGE = "Accounting invoice issue request failed";

// The shape the adapter throws for a backend refusal
// (server/adapters/supabase/accountingInvoicePort.ts:37): the RPC's SQLSTATE and
// its own RAISE identifier.
function refusal(identifier: string): AccountingInvoicePersistenceError {
  return new AccountingInvoicePersistenceError(PERSISTENCE_MESSAGE, "22023", identifier);
}

function fakeProvider(fulfilments: OmnipackReconciliationFulfilment[]): OmnipackReconciliationProvider {
  return {
    getFulfilments: vi.fn(async () => fulfilments),
  };
}

function fakePort(overrides: Partial<OmnipackReconciliationPort> = {}): OmnipackReconciliationPort {
  return {
    findDispatchRef: vi.fn(async () => DISPATCH),
    acknowledgeDispatchAcceptance: vi.fn(async (input) => ({
      dispatchRefId: input.dispatchRefId,
      fulfillmentOrderId: DISPATCH.fulfillmentOrderId,
      orderId: DISPATCH.orderId,
      providerOrderId: input.providerOrderId ?? DISPATCH.providerOrderId,
      dispatchStatus: "created" as const,
      fulfillmentStatus: "label_created",
      replayed: false,
    })),
    latestStatusOccurredAt: vi.fn(async () => null),
    readLocalFulfillmentStatus: vi.fn(async () => "label_created"),
    readHandedOverAt: vi.fn(async () => null),
    readDeliveryCarrier: vi.fn(async () => null),
    recordStatusEvidence: vi.fn(async () => ({ replayed: false })),
    recordTrackingReference: vi.fn(async () => ({ replayed: false, readBack: true })),
    markHandedOver: vi.fn(async () => ({ status: "handed_over", replayed: false })),
    markProviderStockConsumed: vi.fn(async () => ({ status: "packed", replayed: false })),
    recordQuarantine: vi.fn(async () => ({ replayed: false })),
    recordProviderException: vi.fn(async () => ({ replayed: false })),
    ...overrides,
  };
}

function fulfilment(overrides: Partial<OmnipackReconciliationFulfilment> = {}): OmnipackReconciliationFulfilment {
  return {
    provider: "omnipack",
    providerOrderId: null,
    fulfilmentNumber: "FUL-1001",
    externalNumber: "PRORES/Z/00002/2026",
    orderNumber: "openlup-order-1001",
    createdAt: "2026-06-10T08:00:00+00:00",
    updatedAt: "2026-06-10T09:00:00+00:00",
    status: "SHIPPING",
    subStatus: null,
    trackingNumbers: ["TRK-1"],
    ...overrides,
  };
}
