export interface PaymentFormErrorFacts {
  type?: string;
  code?: string;
}
export interface PaymentFormErrorContext {
  /** Supplied only when the existing confirmation classifier proves no dispatch. */
  dispatch: "not_dispatched" | "unknown";
  retryAllowed?: boolean;
}

/** Curated host-copy key. Raw provider text never participates in presentation. */
export function paymentFormErrorPresentation(
  error: PaymentFormErrorFacts,
  context: PaymentFormErrorContext = { dispatch: "unknown" },
): string {
  const code = error.code;
  let id: string;
  if (code === "incomplete_number" || code === "invalid_number" || code === "incorrect_number") id = "c05a";
  else if (code === "incomplete_cvc" || code === "invalid_cvc" || code === "incorrect_cvc") id = "c05b";
  else if (code === "incomplete_expiry" || code === "invalid_expiry_month" || code === "invalid_expiry_year"
    || code === "invalid_expiry_year_past") id = "c05c";
  else if (error.type === "validation_error") id = "c05";
  else if (context.dispatch === "not_dispatched") id = context.retryAllowed ? "c17" : "c17a";
  else id = "c09";
  return `checkout:recoveryGuidance.messages.${id}`;
}
