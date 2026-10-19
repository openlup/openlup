/** Provider-agnostic transport contract, outcome projection and capture transport. */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text alternative; omitted from the outbound payload when absent. */
  text?: string;
  /** Optional reply mailbox; omitted entirely when the caller does not set it. */
  replyTo?: string;
  /** Stable outbound request key retained by the concrete transport for a limited window. */
  idempotencyKey?: string;
  /** Base64 content only; remote URLs and filesystem paths are not supported. */
  attachments?: ReadonlyArray<{ filename: string; content: string }>;
  /** Cancels the in-flight send when the worker's per-row timeout fires. */
  signal?: AbortSignal;
}

/** Transport results preserve existing reference wire shapes. */
export interface EmailSendOutcome {
  ok: boolean;
  /** Legacy identifier retained for reference result compatibility. */
  resendId: string | null;
  httpStatus: number;
  providerError: string | null;
  providerErrorCode?: string | null;
  aborted: boolean;
  suppressed?: "drop" | null;
  egressMode?: "production" | "sandbox_direct" | "sandbox_sink" | "drop";
  egressReason?: string;
}
export interface EmailSendResult {
  outcome: EmailSendOutcome;
  providerResponse: Record<string, unknown>;
}

export type EmailSendSkipReason = "admin_disabled" | "egress_suppressed";

export interface EmailSendOutcomeLike {
  ok: boolean;
  resendId: string | null;
  providerError: string | null;
  aborted?: boolean;
  adminDisabled?: boolean;
  suppressed?: "drop" | null;
  skipReason?: EmailSendSkipReason | null;
}

/** Converts the transport's legacy identifier field at the transport boundary. */
export function emailTransportMessageId(outcome: EmailSendOutcomeLike): string | null {
  return outcome.resendId;
}

/** Maps the neutral message identifier onto the deployed ledger's legacy field. */
export function emailTransportLedgerIdentifier(messageId: string | null): Record<string, string | null> {
  return { resend_id: messageId };
}

/** Synthesizes the canonical terminal transport shape when `send` throws. */
export function failedEmailTransportResult(): EmailSendResult {
  return {
    outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "provider_transport_threw", aborted: false },
    providerResponse: { exception: true },
  };
}

export interface EmailSendOutcomeProjection {
  skipReason: EmailSendSkipReason | null;
  timelineStatus: "sent" | "skipped" | "delivery_delayed" | "failed";
  ledgerStatus: "sent" | "skipped" | "failed";
  sentAtEligible: boolean;
  lastErrorCode: string | null;
}

/** One truth projection for every Node email ledger, timeline and caller. */
export function classifyEmailSendOutcome(outcome: EmailSendOutcomeLike): EmailSendOutcomeProjection {
  const skipReason = outcome.skipReason
    ?? (outcome.adminDisabled ? "admin_disabled" : null)
    ?? (outcome.suppressed === "drop" ? "egress_suppressed" : null);
  if (skipReason) {
    return {
      skipReason,
      timelineStatus: "skipped",
      ledgerStatus: "skipped",
      sentAtEligible: false,
      lastErrorCode: skipReason,
    };
  }
  // `ok` deliberately remains the transport-acceptance contract. In particular,
  // this wave does not turn a historical 2xx-without-id answer into a retry.
  if (outcome.ok) {
    return {
      skipReason: null,
      timelineStatus: "sent",
      ledgerStatus: "sent",
      sentAtEligible: true,
      lastErrorCode: null,
    };
  }
  if (outcome.aborted) {
    return {
      skipReason: null,
      timelineStatus: "delivery_delayed",
      ledgerStatus: "failed",
      sentAtEligible: false,
      lastErrorCode: "provider_request_aborted",
    };
  }
  return {
    skipReason: null,
    timelineStatus: "failed",
    ledgerStatus: "failed",
    sentAtEligible: false,
    lastErrorCode: normalizeEmailFailureCode(outcome.providerError),
  };
}

/** Adds a provider-neutral skip reason without changing ordinary wire shapes. */
export function withEmailSendSkipReason<T extends EmailSendOutcomeLike>(outcome: T): T {
  const skipReason = classifyEmailSendOutcome(outcome).skipReason;
  return skipReason ? { ...outcome, skipReason } : outcome;
}

function normalizeEmailFailureCode(value: string | null): string {
  if (!value) return "provider_send_failed";
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || "provider_send_failed";
}

export interface EmailTransport {
  /** Stable provider tag for ledgers/observability (e.g. "mailProvider", "in-memory"). */
  readonly providerKind: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export interface InMemoryEmailTransport extends EmailTransport {
  /** Every message handed to send(), in order — for tests and dry runs. */
  readonly sent: ReadonlyArray<EmailMessage>;
}

/**
 * Reference capture transport: captures sends in memory and never makes a
 * network call. Proves the seam is real — a port wired to this sends email with
 * no HTTP client — and doubles as the substitute an OSS fork starts from
 * before writing its own SES/SMTP adapter.
 */
export function createInMemoryEmailTransport(opts?: { idPrefix?: string }): InMemoryEmailTransport {
  const sent: EmailMessage[] = [];
  const prefix = opts?.idPrefix ?? "in-memory";
  return {
    providerKind: "in-memory",
    sent,
    async send(message) {
      sent.push(message);
      const id = `${prefix}-${sent.length}`;
      return {
        outcome: { ok: true, resendId: id, httpStatus: 200, providerError: null, aborted: false },
        providerResponse: { id },
      };
    },
  };
}
