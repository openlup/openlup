export const REUSABLE_PAYMENT_METHOD_KINDS = [
  "card",
  "blik_payid",
  "wallet",
  "alias",
] as const;
export type ReusablePaymentMethodKind = (typeof REUSABLE_PAYMENT_METHOD_KINDS)[number];

export const REUSABLE_PAYMENT_METHOD_STATUSES = [
  "pending_verification",
  "active",
  "inactive",
  "expired",
  "revoked",
] as const;
export type ReusablePaymentMethodStatus = (typeof REUSABLE_PAYMENT_METHOD_STATUSES)[number];

export interface ReusablePaymentMethodRef {
  id: string;
  clientId: string;
  subscriptionId: string | null;
  providerKind: string;
  methodKind: ReusablePaymentMethodKind;
  providerCustomerRef: string | null;
  providerMethodRef: string;
  providerMandateRef: string | null;
  status: ReusablePaymentMethodStatus;
  active: boolean;
  expiresAt: string | null;
  consentSnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export function canActivateReusablePaymentMethodRef(
  method: Pick<ReusablePaymentMethodRef, "status" | "expiresAt">,
  now = new Date(),
): boolean {
  if (method.status !== "active") return false;
  if (!method.expiresAt) return true;
  return Date.parse(method.expiresAt) > now.getTime();
}
