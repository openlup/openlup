import { describe, expect, it } from "vitest";
import { COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipient,
  OrderRecipientPort,
  ShipmentDispatchedEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxShipmentDispatchedEmailHandler,
  OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG,
} from "./outboxShipmentDispatchedEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-16T10:00:00.000+00:00",
    available_at: "2026-06-16T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE,
    idempotency_key: "shipment_dispatched:x",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const payload = {
  orderUuid: ORDER_UUID,
  orderId: `order_${ORDER_UUID}`,
  trackingNumber: "JD0123456789",
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
}) {
  const sendCalls: ShipmentDispatchedEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendShipmentDispatchedNotice(input: ShipmentDispatchedEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_sd_1",
          httpStatus: 200,
          providerError: null,
          aborted: false,
        }
      );
    },
  } as unknown as TransactionalEmailPort;
  const recipientPort: OrderRecipientPort = {
    resolve: async () =>
      options?.recipient === undefined
        ? { email: "k@example.com", firstName: "Ola", petName: "Fistaszek" }
        : options.recipient,
  };
  const handler = createOutboxShipmentDispatchedEmailHandler({ emailPort, recipientPort });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxShipmentDispatchedEmailHandler", () => {
  it("claims commerce.shipment.dispatched with a 10s timeout and the dispatched slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG).toBe("commerce-shipment-dispatched");
  });

  it("discards a broken payload", async () => {
    const { handler } = makeDeps();
    expect((await handler.handle(makeRow({ orderUuid: "nope" }), signal())).kind).toBe("discard");
  });

  it("skips an unresolved recipient and dedupes an already-sent notice", async () => {
    const skip = makeDeps({ recipient: null });
    expect(await skip.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { skipped: "recipient_unresolved" },
    });

    const dup = makeDeps({ existing: true });
    expect(await dup.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { dedupe: "email_already_sent" },
    });
    expect(dup.sendCalls).toHaveLength(0);
  });

  it("keeps the legacy direct-DHL tracking URL fallback from a bare tracking number", async () => {
    const sent = makeDeps();
    const outcome = await sent.handler.handle(makeRow(payload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_sd_1" } });
    expect(sent.sendCalls[0].trackingNumber).toBe("JD0123456789");
    expect(sent.sendCalls[0].petName).toBe("Fistaszek");
    expect(sent.sendCalls[0].trackingUrl).toContain("tracking-id=JD0123456789");
  });

  it("uses an OmniPack InPost provider-supplied tracking URL without rewriting it to the DHL fallback", async () => {
    const sent = makeDeps();
    const trackingUrl = "https://tracking.omnipack.test/inpost/POINT123/TRACK-OMNI-1";
    const outcome = await sent.handler.handle(
      makeRow({
        ...payload,
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: "inpost",
          service: "INPOST_PACZKOMAT",
          trackingNumber: "TRACK-OMNI-1",
          trackingUrl,
        }],
      }),
      signal(),
    );

    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_sd_1" } });
    expect(sent.sendCalls[0].trackingNumber).toBe("TRACK-OMNI-1");
    expect(sent.sendCalls[0].trackingUrl).toBe(trackingUrl);
  });

  it("builds the DPD registry URL (never the DHL fallback) for OmniPack DPD tracking without a provider URL", async () => {
    const sent = makeDeps();
    const outcome = await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: "dpd",
          service: "DPD_COURIER_STANDARD",
          trackingNumber: "DPD-TRACK-1",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_sd_1" } });
    expect(sent.sendCalls[0].trackingNumber).toBe("DPD-TRACK-1");
    expect(sent.sendCalls[0].trackingUrl).toBe("https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=DPD-TRACK-1");
  });

  it("builds the InPost registry URL from carrier evidence alone (live prod gap: refs persisted without a URL)", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: null,
          service: "inpost_locker_standard",
          trackingNumber: "620999680605074433453432",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("620999680605074433453432");
    expect(sent.sendCalls[0].trackingUrl).toBe(
      "https://inpost.pl/sledzenie-przesylek?number=620999680605074433453432",
    );
  });

  it("keeps the email number-only for carriers without a registry URL", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: "gls",
          service: "GLS_STANDARD",
          trackingNumber: "GLS-TRACK-1",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("GLS-TRACK-1");
    expect(sent.sendCalls[0].trackingUrl).toBeNull();
  });

  it("maps OmniPack-routed DHL to the DHL registry URL when the provider URL is missing", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: "dhl",
          service: "DHL_COURIER_STANDARD",
          trackingNumber: "JD-OMNI-DHL-1",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("JD-OMNI-DHL-1");
    expect(sent.sendCalls[0].trackingUrl).toContain("tracking-id=JD-OMNI-DHL-1");
  });

  it("prefers explicit OmniPack refs over a legacy root tracking URL", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingNumber: "JD-LEGACY-ROOT",
        trackingUrl: "https://www.dhl.com/pl-pl/home/tracking.html?tracking-id=JD-LEGACY-ROOT",
        trackingReferences: [{
          providerKind: "omnipack",
          carrierKind: "dpd",
          service: "DPD_COURIER_STANDARD",
          trackingNumber: "DPD-TRACK-2",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("DPD-TRACK-2");
    expect(sent.sendCalls[0].trackingUrl).toBe("https://tracktrace.dpd.com.pl/parcelDetails?typ=1&p1=DPD-TRACK-2");
  });

  it("keeps explicit direct-DHL provider evidence on the DHL fallback path", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [{
          providerKind: "dhl",
          carrierKind: "dhl",
          service: "DHL_DIRECT",
          trackingNumber: "JD-DIRECT-1",
          trackingUrl: null,
        }],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("JD-DIRECT-1");
    expect(sent.sendCalls[0].trackingUrl).toContain("tracking-id=JD-DIRECT-1");
  });

  it("uses the first URL-bearing tracking ref as the email CTA for multiple packages", async () => {
    const sent = makeDeps();
    await sent.handler.handle(
      makeRow({
        orderUuid: ORDER_UUID,
        orderId: `order_${ORDER_UUID}`,
        trackingReferences: [
          {
            providerKind: "omnipack",
            carrierKind: "dpd",
            service: "DPD_COURIER_STANDARD",
            trackingNumber: "DPD-1",
            trackingUrl: null,
          },
          {
            providerKind: "omnipack",
            carrierKind: "inpost",
            service: "INPOST_PACZKOMAT",
            trackingNumber: "INPOST-1",
            trackingUrl: "https://inpost.example/track/INPOST-1",
          },
        ],
      }),
      signal(),
    );

    expect(sent.sendCalls[0].trackingNumber).toBe("INPOST-1");
    expect(sent.sendCalls[0].trackingUrl).toBe("https://inpost.example/track/INPOST-1");
  });

  it("discards invalid provider-supplied tracking URLs before sending", async () => {
    const sent = makeDeps();
    const outcome = await sent.handler.handle(
      makeRow({ ...payload, trackingUrl: "not-a-url" }),
      signal(),
    );

    expect(outcome.kind).toBe("discard");
    expect(sent.sendCalls).toHaveLength(0);
  });

  it("passes null tracking through (no URL) when the carrier id is absent", async () => {
    const noTracking = makeDeps();
    await noTracking.handler.handle(
      makeRow({ orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}`, trackingNumber: null }),
      signal(),
    );
    expect(noTracking.sendCalls[0].trackingNumber).toBeNull();
    expect(noTracking.sendCalls[0].trackingUrl).toBeNull();
  });

  it("snoozes on a 503 and discards on a 422", async () => {
    const snooze = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false },
    });
    expect(await snooze.handler.handle(makeRow(payload), signal())).toEqual({ kind: "snooze", reason: "down" });

    const discard = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 422, providerError: null, aborted: false },
    });
    expect(await discard.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });
});
