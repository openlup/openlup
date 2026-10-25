import { describe, expect, it, vi } from "vitest";
import * as schemas from "./omsContractReadSchemas.js";
import { listResponse } from "./omsClient.fixtures.js";
import { readQueueSelection } from "../../../server/adapters/supabase/commerce/oms/queueSelection.js";
import { defaultOmsFulfillmentDebug } from "./omsFulfillmentDebugSchemas.js";
import { ambientSettlementProfile } from "../../lib/currency/platformCurrency.js";
describe("reference OMS schema binding", () => {
  it("retains the reference fallback debug summary and serialized field order", () => {
    const previous = { summary: "Brak danych fulfillmentu.", severity: "watch", nextAction: "wait", blockers: [], steps: [] };
    expect(JSON.stringify(defaultOmsFulfillmentDebug)).toBe(JSON.stringify(previous));
    expect(JSON.stringify(schemas.omsOrderDetailSchema.shape.fulfillmentDebug.parse(undefined))).toBe(JSON.stringify(previous));
  });
  it("retains the BASE schema field order for serialized responses and errors", () => {
    expect(Object.keys(schemas.omsAccountingSummarySchema.shape)).toEqual(["status", "invoiceId", "invoiceRef", "providerKind", "providerInvoiceNumber", "ksefStatus", "outboxStatus", "outboxAttemptCount", "outboxNextAttemptAt", "outboxLastError", "recoveryGuidance", "updatedAt"]);
    expect(Object.keys(schemas.omsOrderListItemSchema.shape)).toEqual(["orderId", "orderNumber", "clientId", "customer", "pet", "status", "mode", "sourceKind", "sourceChannelSlug", "sourceOrderRef", "paymentMethodLabel", "paymentProvider", "paymentStatus", "fulfillmentStatus", "customerFulfillmentStep", "inventoryStatus", "accountingStatus", "providerOpsStatus", "providerOpsSla", "providerOrderId", "attentionReason", "nextAction", "activeHoldCount", "activeHoldReasons", "fulfillmentHealthDigest", "total", "pricingSummary", "createdAt", "updatedAt", "match"]);
    expect(Object.keys(schemas.omsOrderDetailSchema.shape)).toEqual([...Object.keys(schemas.omsOrderListItemSchema.shape),"firstSubscriptionPricePresentation", "shippingAddress", "deliveryContact", "billingAddress", "deliverySelection", "lines", "subscription", "fulfillmentEligibility", "inventory", "fulfillment", "replacementChain", "fulfillmentHealth", "fulfillmentDebug", "accounting", "actionEligibility", "holds", "operations", "payment", "paymentAttempts", "paymentTransitions", "communicationDeliveries"]);
  });
  it("keeps private search vocabulary closed and drops only invalid queue matches", async () => {
    expect(schemas.omsOrderSearchMatchSchema.safeParse({ field: "raw_email", label: "example", valuePreview: null }).success).toBe(false);
    const fixture = listResponse();
    const rpc = vi.fn().mockResolvedValue({ data: { orderIds: [], totalCount: 0, matches: { invalid: { field: "raw_email", label: "example", valuePreview: null }, valid: { field: "order_number", label: "example", valuePreview: null } }, summaryCounts: fixture.summaryCounts, summaryTotals: fixture.summaryTotals }, error: null });
    const result = await readQueueSelection({ rpc } as never, { page: 1, pageSize: 25, sort: "created_desc" });
    expect(result.matches).toEqual({ valid: { field: "order_number", label: "example", valuePreview: null } });
  });
  it("keeps the direct pricing-summary export bound to settlement currency", () => {
    const other = ambientSettlementProfile.defaultCurrency === "XTS" ? "XXX" : "XTS";
    const input = listResponse().orders[0]!.pricingSummary;
    expect(schemas.omsPricingSummarySchema.safeParse(input).success).toBe(true);
    expect(schemas.omsPricingSummarySchema.safeParse({ ...input, subtotal: { ...input.subtotal, currency: other } }).success).toBe(false);
  });
});
