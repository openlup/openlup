import { createPaymentServices, createVerifiedPaymentIngress } from "@openlup/platform/payments";
import type { PaymentServicesOptions } from "@openlup/platform/payments/contracts";

/** Opt-in host selection. Unknown names refuse before opening any capability. */
export function bindM07Payments(selection: string | undefined, options: PaymentServicesOptions) {
  if (selection === undefined || selection === "off") return null;
  if (selection !== "truth") throw new Error("payment_binding_unknown_selection");
  const services = createPaymentServices(options);
  if (!services) throw new Error("payment_binding_truth_unavailable");
  return services;
}

/** The host supplies verified adapters and durable processing ports explicitly. */
export function bindM07PaymentIngress(
  selection: string | undefined,
  options: Parameters<typeof createVerifiedPaymentIngress>[0],
) {
  if (selection === undefined || selection === "off") return null;
  if (selection !== "verified") throw new Error("payment_binding_unknown_selection");
  return createVerifiedPaymentIngress(options);
}
