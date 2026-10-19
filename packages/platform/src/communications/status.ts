import type { EmailSendDecision, EmailSendStatus } from "./contracts/types.js";

const TERMINAL_EMAIL_STATUSES = new Set<EmailSendStatus>([
  "bounced",
  "complained",
  "failed",
  "skipped",
]);

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
