import { describe, expect, it, vi } from "vitest";

import { closeOrderPaidShipmentSpinePort } from "../../server/runtime/fulfillment/shipmentSpineBinding.js";
import { composeOrderPaidFulfillmentPort } from "./outboxFulfillmentProvider.js";

const SHIPMENT_ID = "51111111-1111-4111-8111-111111111111";
const ORDER_ID = "41111111-1111-4111-8111-111111111111";

describe("direct PostgreSQL outbox fulfillment composition", () => {
  it("reuses the shipped spine across a batch and closes it at the batch boundary", async () => {
    const result = (status: string) => ({ shipmentId: SHIPMENT_ID, orderId: ORDER_ID, status, replayed: false });
    const createShipment = vi.fn(async () => result("created"));
    const recordLabel = vi.fn(async () => result("label_created"));
    const handOff = vi.fn(async () => result("handed_over"));
    const close = vi.fn(async () => {});
    const resolveShipmentSpine = vi.fn(() => ({ binding: {
      createShipment,
      recordLabel,
      handOff,
      recordTracking: vi.fn(),
      cancel: vi.fn(),
      raiseException: vi.fn(),
      close,
    } }));
    const port = composeOrderPaidFulfillmentPort({
      client: {} as never,
      env: { PLATFORM_BUNDLE: "node-postgres", ACCOUNTING_REQUEST_ENABLED: "true" },
      fulfillmentReady: true,
      resolveShipmentSpine: resolveShipmentSpine as never,
      resolveAccountingPaidOrderDocument: vi.fn(() => ({
        requestInvoiceIssueFromPaidOrder: vi.fn(async () => ({ replayed: false })),
        close: vi.fn(async () => {}),
      })) as never,
    });
    const request = {
      orderUuid: ORDER_ID,
      outboxEventId: "61111111-1111-4111-8111-111111111111",
      signal: new AbortController().signal,
    };

    await expect(port?.ensureFulfilledFromPaidOrder(request)).resolves.toEqual({
      kind: "completed",
      detail: { fulfillmentOrderId: SHIPMENT_ID, status: "handed_over", replayed: false },
    });
    await expect(port?.ensureFulfilledFromPaidOrder(request)).resolves.toMatchObject({ kind: "completed" });
    expect(close).not.toHaveBeenCalled();
    await closeOrderPaidShipmentSpinePort(port);

    expect(resolveShipmentSpine).toHaveBeenCalledWith(
      expect.objectContaining({ PLATFORM_BUNDLE: "node-postgres" }),
      { requiredProviderType: "simulator" },
    );
    expect(createShipment).toHaveBeenCalledTimes(2);
    expect(recordLabel).toHaveBeenCalledTimes(2);
    expect(handOff).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["paid", "handoff"] as const)(
    "preserves the %s accounting request in the direct composition",
    async (issueTrigger) => {
      const requestInvoiceIssueFromPaidOrder = vi.fn(async () => ({ replayed: false }));
      const accountingClose = vi.fn(async () => {});
      const fulfillmentClose = vi.fn(async () => {});
      const resolveShipmentSpine = vi.fn(() => ({ binding: {
        createShipment: vi.fn(async () => ({ shipmentId: SHIPMENT_ID, orderId: ORDER_ID, status: "created", replayed: false })),
        recordLabel: vi.fn(async () => ({ shipmentId: SHIPMENT_ID, orderId: ORDER_ID, status: "label_created", replayed: false })),
        handOff: vi.fn(async () => ({ shipmentId: SHIPMENT_ID, orderId: ORDER_ID, status: "handed_over", replayed: false })),
        recordTracking: vi.fn(), cancel: vi.fn(), raiseException: vi.fn(), close: fulfillmentClose,
      } }));
      const port = composeOrderPaidFulfillmentPort({
        client: {} as never,
        env: {
          PLATFORM_BUNDLE: "node-postgres",
          ACCOUNTING_REQUEST_ENABLED: "true",
          ACCOUNTING_ISSUE_TRIGGER: issueTrigger,
        },
        fulfillmentReady: true,
        resolveShipmentSpine: resolveShipmentSpine as never,
        resolveAccountingPaidOrderDocument: vi.fn(() => ({
          requestInvoiceIssueFromPaidOrder,
          close: accountingClose,
        })) as never,
      });

      await port?.ensureFulfilledFromPaidOrder({
        orderUuid: ORDER_ID,
        outboxEventId: "61111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      });
      expect(requestInvoiceIssueFromPaidOrder).toHaveBeenCalledWith(expect.objectContaining({
        orderId: ORDER_ID,
        idempotencyKey: `order-paid-dispatch:${ORDER_ID}:accounting-invoice-${issueTrigger}`,
      }));
      await closeOrderPaidShipmentSpinePort(port);
      expect(fulfillmentClose).toHaveBeenCalledOnce();
      expect(accountingClose).toHaveBeenCalledOnce();
    },
  );

  it("fails closed when accounting is required but its direct binding is unavailable", () => {
    const close = vi.fn(async () => {});
    const port = composeOrderPaidFulfillmentPort({
      client: {} as never,
      env: { PLATFORM_BUNDLE: "node-postgres", ACCOUNTING_REQUEST_ENABLED: "true" },
      fulfillmentReady: true,
      resolveShipmentSpine: vi.fn(() => ({ binding: {
        createShipment: vi.fn(), recordLabel: vi.fn(), handOff: vi.fn(), recordTracking: vi.fn(),
        cancel: vi.fn(), raiseException: vi.fn(), close,
      } })) as never,
      resolveAccountingPaidOrderDocument: vi.fn(() => null),
    });

    expect(port).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
