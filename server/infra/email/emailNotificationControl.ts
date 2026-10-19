import { createEmailNotificationControlPort as createControl, type EmailNotificationControlClient } from "@openlup/platform/communications";
import { createSupabaseDeliveryShapingPolicy } from "../../shared/deliveryShapingPolicy.js";
export { EMAIL_NOTIFICATION_ADMIN_DISABLED, EMAIL_NOTIFICATION_CONTROL_FAMILY_KEYS, emailNotificationControlKeys } from "../../shared/emailNotificationControlKeys.js";
export type { EmailNotificationControlPort, EmailNotificationControlClient } from "@openlup/platform/communications";
export function createEmailNotificationControlPort(client: EmailNotificationControlClient) { return createControl(client, createSupabaseDeliveryShapingPolicy); }
export const createSupabaseEmailNotificationControlPort = createEmailNotificationControlPort;
