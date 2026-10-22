import type { FulfillmentProgressInput, FulfillmentProgressPresentation } from './contracts/read.js';
import { CUSTOMER_STEP_SEQUENCE, phaseIndexForStep, stepForToken } from './statusMap.js';
import type { CustomerFulfillmentStep } from './contracts/index.js';
/** The host resolves its existing step; only actual recorded milestones complete. */
export function fulfillmentProgressPresentation(order: FulfillmentProgressInput, step: CustomerFulfillmentStep): FulfillmentProgressPresentation | null {
  const status = order.status.toLowerCase();
  const rawPayment = order.paymentStatus?.toLowerCase() ?? "";
  const payment = rawPayment === "paid" ? "succeeded" : rawPayment;
  const paid = payment === "succeeded";
  const terminal = status === "cancelled" || status === "refunded";
  const orderMilestone = stepForToken(status);
  const recordedOrderMilestone = orderMilestone !== null && orderMilestone !== "paid"
    && CUSTOMER_STEP_SEQUENCE.includes(orderMilestone as typeof CUSTOMER_STEP_SEQUENCE[number]);
  const parcelEvidence = recordedOrderMilestone || Boolean(order.fulfillmentStatus)
    || Boolean(order.customerFulfillmentStep && step !== "paid" && !["draft", "failed", "expired"].includes(status))
    || order.trackingTimeline.some((event) => {
      const observed = stepForToken(event.eventType);
      return observed !== null && observed !== "paid";
    });
  const advancedParcel = !terminal && parcelEvidence && step !== "paid";
  return progressPresentation(order, step, paid, terminal, advancedParcel);
}

function progressPresentation(
  order: FulfillmentProgressInput,
  step: CustomerFulfillmentStep,
  paid: boolean,
  terminal: boolean,
  advancedParcel: boolean,
): FulfillmentProgressPresentation | null {
  if (terminal || ["draft", "expired"].includes(order.status.toLowerCase())
    || step === "exception" || step === "cancelled" || !paid && !advancedParcel) return null;
  const completed = new Set<CustomerFulfillmentStep>(paid ? ["paid"] : []);
  const record = (token: string | null | undefined) => {
    const observed = stepForToken(token);
    // No historical inference from an index, and no payment proof from parcel tokens.
    if (observed && observed !== "paid" && CUSTOMER_STEP_SEQUENCE.includes(observed as typeof CUSTOMER_STEP_SEQUENCE[number])
      && phaseIndexForStep(observed) <= phaseIndexForStep(step)) completed.add(observed);
  };
  if (advancedParcel) {
    record(order.fulfillmentStatus);
    record(step);
    order.trackingTimeline.forEach((event) => record(event.eventType));
  }
  return {
    completedSteps: [...completed],
    currentStep: advancedParcel && step !== "delivered" ? step : null,
  };
}
