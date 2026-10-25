import { createOutboxOrderPaidFulfillmentHandler } from "../../fulfillment/index.js";
export { createOutboxOrderPaidFulfillmentHandler, outboxOrderPaidFulfillmentDescriptor } from "../../fulfillment/index.js";

export type OrderPaidRiskAssessmentPort = NonNullable<Parameters<typeof createOutboxOrderPaidFulfillmentHandler>[0]["riskPort"]>;
