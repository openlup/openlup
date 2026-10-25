import type { createOutboxOrderPaidFulfillmentHandler } from "../../fulfillment/index.js";
export type OrderPaidFulfillmentPort = Parameters<typeof createOutboxOrderPaidFulfillmentHandler>[0]["fulfillmentPort"];
export type OrderPaidFulfillmentResult = Awaited<ReturnType<OrderPaidFulfillmentPort["ensureFulfilledFromPaidOrder"]>>;
