import { createSupabaseResendDeliveryReconciliationPort as createPort } from "@openlup/platform/communications";
export function createSupabaseResendDeliveryReconciliationPort(client: Parameters<typeof createPort>[0]) {
  return createPort(client, "resend-delivery-reconciliation");
}
