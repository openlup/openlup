import { describe, expect, it, vi } from "vitest";
import { COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";

// No registered provider owns the delivered notice today, so a stub kind keeps the
// suppression branch the handler retains for a future provider under test.
vi.mock("../../../src/domains/fulfillment/contracts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/domains/fulfillment/contracts.js")>();
  return {
    ...actual,
    providerOwnsDeliveredNotification: (kind: string | null | undefined) =>
      kind === "carrier_owned_stub" || actual.providerOwnsDeliveredNotification(kind),
  };
});
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipient,
  OrderRecipientPort,
  ShipmentDeliveredEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxShipmentDeliveredEmailHandler,
  OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG,
} from "./outboxShipmentDeliveredEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-666666666666";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-16T10:00:00.000+00:00",
    available_at: "2026-06-16T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE,
    idempotency_key: "shipment_delivered:x",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const payload = { orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}` };

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
  // W6: when set, inject a provider-kind reader (the flag-on path).
  providerKind?: string | null;
}) {
  const sendCalls: ShipmentDeliveredEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendShipmentDeliveredNotice(input: ShipmentDeliveredEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_dl_1",
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
  const providerKindReader =
    options?.providerKind === undefined
      ? undefined
      : { readSelectedProviderKind: async () => options.providerKind ?? null };
  const handler = createOutboxShipmentDeliveredEmailHandler({ emailPort, recipientPort, providerKindReader });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxShipmentDeliveredEmailHandler", () => {
  it("claims commerce.shipment.delivered with a 10s timeout and the delivered slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG).toBe("commerce-shipment-delivered");
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

  it("sends the delivered notice with the order id", async () => {
    const sent = makeDeps();
    const outcome = await sent.handler.handle(makeRow(payload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_dl_1" } });
    expect(sent.sendCalls[0].orderId).toBe(`order_${ORDER_UUID}`);
    expect(sent.sendCalls[0].petName).toBe("Fistaszek");
  });

  it("sends OUR delivered email for OmniPack too: the carrier notice is not a substitute (owner decision 2026-09-14)", async () => {
    const omnipack = makeDeps({ providerKind: "omnipack" });
    expect(await omnipack.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { resendId: "re_dl_1" },
    });
    expect(omnipack.sendCalls).toHaveLength(1);
  });

  it("still suppresses OUR delivered email for a provider whose profile owns the notice", async () => {
    const owned = makeDeps({ providerKind: "carrier_owned_stub" });
    expect(await owned.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { skipped: "carrier_owns_delivered:carrier_owned_stub" },
    });
    expect(owned.sendCalls).toHaveLength(0);
  });

  it("W6: still sends the delivered email for a non-carrier-owned provider (simulator)", async () => {
    const sim = makeDeps({ providerKind: "simulator" });
    expect((await sim.handler.handle(makeRow(payload), signal())).kind).toBe("processed");
    expect(sim.sendCalls).toHaveLength(1);
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
