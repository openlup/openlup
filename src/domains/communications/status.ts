import { isTerminalEmailSendStatus } from "@openlup/platform/communications";
export { isTerminalEmailSendStatus, buildEmailSendDedupeKey, decideEmailSend } from "@openlup/platform/communications";
import type {
  EmailSendStatus,
  ResendEmailEventType,
} from "./types.js";

const RESEND_EVENT_KIND_MAP: Record<ResendEmailEventType, string> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.opened": "open",
  "email.clicked": "click",
  "email.bounced": "bounce",
  "email.complained": "complaint",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
  "email.scheduled": "scheduled",
};

const RESEND_STATUS_MAP: Partial<Record<ResendEmailEventType, EmailSendStatus>> = {
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "failed",
};

export function resendEventKind(eventType: string): string | null {
  return RESEND_EVENT_KIND_MAP[eventType as ResendEmailEventType] ?? null;
}

export function nextEmailSendStatus(
  currentStatus: string | null,
  resendEventType: string,
): EmailSendStatus | null {
  const nextStatus = RESEND_STATUS_MAP[resendEventType as ResendEmailEventType] ?? null;
  if (!nextStatus) return null;
  if (isTerminalEmailSendStatus(currentStatus)) return null;
  if (currentStatus === "delivered" && nextStatus === "sent") return null;

  return nextStatus;
}
