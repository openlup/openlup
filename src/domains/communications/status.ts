import type {
  EmailSendDecision,
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

const TERMINAL_EMAIL_STATUSES = new Set<EmailSendStatus>([
  "bounced",
  "complained",
  "failed",
  "skipped",
]);

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

export function isTerminalEmailSendStatus(status: string | null): status is EmailSendStatus {
  return status !== null && TERMINAL_EMAIL_STATUSES.has(status as EmailSendStatus);
}

export function buildEmailSendDedupeKey(input: {
  recipientId: string;
  templateSlug: string;
}): string {
  return `email:${input.recipientId.trim()}:${input.templateSlug.trim()}`;
}

export function decideEmailSend(input: {
  sequencePaused: boolean | null;
  existingNonFailedMessageId: string | null;
  templateAvailable: boolean;
}): EmailSendDecision {
  if (input.sequencePaused) {
    return {
      outcome: "skip",
      reason: "sequence_paused",
      existingMessageId: null,
    };
  }

  if (input.existingNonFailedMessageId) {
    return {
      outcome: "skip",
      reason: "already_sent",
      existingMessageId: input.existingNonFailedMessageId,
    };
  }

  if (!input.templateAvailable) {
    return {
      outcome: "skip",
      reason: "template_unavailable",
      existingMessageId: null,
    };
  }

  return { outcome: "send" };
}
