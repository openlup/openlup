import { logAdminDisabledEmailSend as log } from "@openlup/platform/communications";
import { EMAIL_NOTIFICATION_ADMIN_DISABLED } from "../../infra/email/emailNotificationControl.js";
export type { EmailNotificationSkipLogClient } from "@openlup/platform/communications";
export async function logAdminDisabledEmailSend(input: Parameters<typeof log>[0]): Promise<void> { return log(input, EMAIL_NOTIFICATION_ADMIN_DISABLED); }
