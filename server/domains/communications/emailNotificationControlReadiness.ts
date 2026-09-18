import {
  EMAIL_CANON_DYNAMIC_PATTERNS,
  EMAIL_CANON_REGISTRY,
  hasStaticEmailNotificationControl,
} from "../../../src/domains/communications/emailCanon.js";

export interface MandatoryNotificationControlReadiness {
  requiredControlCount: number;
  disabledControlKeys: string[];
}

function isMandatoryCustomerControl(entry: {
  customerFacing: boolean;
  recipientKind: string;
  deliveryStatus: string;
  inventoryStatus: string;
  policyFailureMode: string;
}): boolean {
  return entry.customerFacing &&
    entry.recipientKind === "customer" &&
    (entry.inventoryStatus === "runtime" || entry.inventoryStatus === "dynamic_runtime") &&
    entry.deliveryStatus === "implemented" &&
    entry.policyFailureMode === "fail_closed";
}

/**
 * The email canon remains the only inventory of mandatory customer mail. This
 * projection intentionally excludes planned, no-send, external-provider, and
 * non-customer entries rather than maintaining a second control registry.
 */
export const MANDATORY_CUSTOMER_NOTIFICATION_CONTROL_KEYS = [
  ...EMAIL_CANON_REGISTRY
    .filter((entry) => hasStaticEmailNotificationControl(entry) && isMandatoryCustomerControl(entry))
    .map((entry) => entry.slug),
  ...EMAIL_CANON_DYNAMIC_PATTERNS
    .filter(isMandatoryCustomerControl)
    .map((entry) => entry.notificationControlKey),
].sort();
