import { describe, expect, it, vi } from "vitest";
import type { OrderInvoicePolicy } from "../../../src/domains/channels/ports.js";
import {
  decideChannelInvoice,
  type OrderInvoicePolicyReader,
} from "./channelInvoicePolicyGate.js";

const ORDER_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FULFILLMENT_ORDER_ID = "ffffffff-1111-2222-3333-444444444444";

function readerFor(policy: OrderInvoicePolicy | null): OrderInvoicePolicyReader & {
  readOrderInvoicePolicy: ReturnType<typeof vi.fn>;
} {
  return { readOrderInvoicePolicy: vi.fn(async () => policy) };
}

describe("decideChannelInvoice", () => {
  it("issues when no reader is composed, so every pre-B6 composition is unchanged", async () => {
    await expect(decideChannelInvoice(undefined, { by: "order", orderUuid: ORDER_UUID }))
      .resolves.toEqual({ issue: true, action: "issue", detail: {} });
  });

  it("issues for a storefront order, which names no channel", async () => {
    const reader = readerFor(null);
    await expect(decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID }))
      .resolves.toMatchObject({ issue: true, action: "issue" });
  });

  it("issues for a channel whose operator declared `issue`", async () => {
    const reader = readerFor({ sourceKind: "marketplace", invoicePolicy: "issue" });
    await expect(decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID }))
      .resolves.toMatchObject({ issue: true, action: "issue" });
  });

  it("refuses and names the reason for `suppress`", async () => {
    const reader = readerFor({ sourceKind: "marketplace", invoicePolicy: "suppress" });
    await expect(decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID }))
      .resolves.toEqual({
        issue: false,
        action: "suppress",
        detail: { invoicePolicy: "suppress", accountingInvoiceSkipped: "suppress" },
      });
  });

  it("refuses and stamps the far side as the issuer for `channel_issues`", async () => {
    const reader = readerFor({ sourceKind: "marketplace", invoicePolicy: "channel_issues" });
    await expect(decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID }))
      .resolves.toEqual({
        issue: false,
        action: "channel_issues",
        detail: {
          invoicePolicy: "channel_issues",
          invoiceIssuedBy: "channel",
          accountingInvoiceSkipped: "channel_issues",
        },
      });
  });

  it("passes each producer's own key through untouched", async () => {
    const reader = readerFor(null);
    await decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID });
    await decideChannelInvoice(reader, { by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID });
    expect(reader.readOrderInvoicePolicy.mock.calls).toEqual([
      [{ by: "order", orderUuid: ORDER_UUID }],
      [{ by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID }],
    ]);
  });

  it("does NOT swallow a read failure — the caller's own catch owns the policy", async () => {
    // Each producer already sits inside a try/catch whose semantics are right
    // for its path (retry for the outbox handlers, fail-soft for the wrappers).
    // Catching here would replace all four with one wrong answer.
    const reader: OrderInvoicePolicyReader = {
      readOrderInvoicePolicy: async () => {
        throw new Error("order_channel_policy_read_failed: commerce_orders: boom");
      },
    };
    await expect(decideChannelInvoice(reader, { by: "order", orderUuid: ORDER_UUID }))
      .rejects.toThrow("order_channel_policy_read_failed");
  });
});
