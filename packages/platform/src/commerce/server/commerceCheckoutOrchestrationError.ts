/**
 * Carries the order id only after inventory may need compensation. A nullable
 * reason lets the handler distinguish safe conflicts from generic failures.
 */
export class CheckoutOrchestrationError extends Error {
  readonly orderIdForCompensation: string | null;
  readonly reason: string | null;

  constructor(message: string, orderIdForCompensation: string | null, reason: string | null = null) {
    super(message);
    this.name = "CheckoutOrchestrationError";
    this.orderIdForCompensation = orderIdForCompensation;
    this.reason = reason;
  }
}
