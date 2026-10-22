import { expect, it } from "vitest";
import { applyFulfillmentObservationEffects } from "../../src/fulfillment/index.js";
import { observationStatusPolicy as policy } from "../../src/fulfillment/observationProjection.js";
import { observation } from "./fixtures.js";

it("matches the original inline stock→handoff→tracking→invoice trace, callbacks and throw boundaries (F5)", async () => {
  type Input = Parameters<typeof applyFulfillmentObservationEffects<string, string>>[0];
  // O's pre-extraction inline decisions, kept independent of the extracted mechanism.
  const inline = async (input: Input) => {
    if (["packed", "in_transit", "delivered"].includes(input.localStatus)) {
      const stock = await input.port.markProviderStockConsumed({ idempotencyKey: input.stockIdempotencyKey, fulfillmentOrderId: input.ids.fulfillmentOrderId });
      if (stock.replayed) input.onReplayed?.();
    }
    if (!["in_transit", "delivered"].includes(input.localStatus)) return;
    const handoff = await input.port.markHandedOver({ idempotencyKey: input.handoffIdempotencyKey, fulfillmentOrderId: input.ids.fulfillmentOrderId, suppressDispatched: input.localStatus === "delivered" });
    if (handoff.replayed) input.onReplayed?.();
    for (const ref of input.trackingRefs) {
      const result = await input.port.recordTrackingReference({ idempotencyKey: input.trackingIdempotencyKey(ref.trackingNumber), orderId: input.ids.orderId, fulfillmentOrderId: input.ids.fulfillmentOrderId,
        trackingNumber: ref.trackingNumber, trackingUrl: ref.trackingUrl ?? null, carrierKind: ref.carrierKind ?? null, service: ref.service ?? null,
        status: input.localStatus, observation: input.observation });
      input.onTrackingRecorded?.(result);
    }
    await input.issueAccountingInvoice?.();
  };
  for (const status of ["provider_received", "picking", "packed", "in_transit", "delivered", "exception", "cancelled"] as const) {
    for (const failAt of [null, "stock", "handoff", "TRACK-a", "invoice"]) {
      const traces: unknown[][] = [];
      for (const run of [inline, (input: Input) => applyFulfillmentObservationEffects(input, policy as Parameters<typeof applyFulfillmentObservationEffects<string, string>>[1])]) {
        const trace: unknown[] = []; traces.push(trace);
        const step = (name: string, data?: unknown) => { trace.push([name, data]); if (failAt === name) throw new Error(name); };
        try {
          await run({ port: {
            async markProviderStockConsumed(value) { step("stock", value); return { replayed: true }; },
            async markHandedOver(value) { step("handoff", value); return { replayed: true }; },
            async recordTrackingReference(value) { step(value.trackingNumber, value); return { replayed: true, readBack: true }; },
          }, localStatus: status, ids: { orderId: "order-a", fulfillmentOrderId: "fulfillment-a" }, observation: observation(status),
            trackingRefs: [{ trackingNumber: "TRACK-a" }, { trackingNumber: "TRACK-b", service: "service-b" }],
            stockIdempotencyKey: "legacy-stock", handoffIdempotencyKey: "legacy-handoff", trackingIdempotencyKey: n => `legacy:${n}`,
            async issueAccountingInvoice() { step("invoice"); }, onReplayed: () => { trace.push("replayed"); }, onTrackingRecorded: result => { trace.push(["callback", result]); } });
        } catch (error) { trace.push(["thrown", (error as Error).message]); }
      }
      expect(traces[1], `${status}/${failAt}`).toEqual(traces[0]);
    }
  }
});
