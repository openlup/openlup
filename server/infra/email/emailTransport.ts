/**
 * Provider-neutral email transport seam (the OSS swap point).
 *
 * openlup aims to ship as a provider-agnostic commerce core, but every Node
 * email port reached Resend through `postResendEmail`. This interface names that
 * boundary so a fork can drop in SES / SMTP / a console logger by implementing
 * `EmailTransport` — the ports depend on the interface, never on Resend's
 * endpoint, auth header, or response shape (all of which stay isolated in
 * server/infra/resend/resendEmailClient.ts).
 *
 * `send()` returns the SAME `{ outcome, providerResponse }` the ports already
 * consume for their ledger/timeline writes, so swapping a port from
 * `postResendEmail` to an injected transport is behaviour-preserving.
 *
 * Note: this is the SEND seam only. It carries no cross-runtime parity
 * obligation: the Deno half was undeployed on 2026-09-04 and its source retired
 * on 2026-09-05, and every sender now renders through
 * src/domains/communications/email/render.ts.
 */

import {
  postResendEmail,
  type ResendEmailPostResult,
  type ResendEmailSendOutcome,
} from "../resend/resendEmailClient.js";

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

/** Neutral aliases so ports type against the seam, not the Resend client. */
export type EmailSendOutcome = ResendEmailSendOutcome;
export type EmailSendResult = ResendEmailPostResult;

export const DEFAULT_EMAIL_PROVIDER_KIND = "resend";

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
  /** Stable provider tag for ledgers/observability (e.g. "resend", "in-memory"). */
  readonly providerKind: string;
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/**
 * Resend-backed transport — the production adapter. Delegates verbatim to the
 * single isolated Resend client (endpoint, auth, error parsing, and the
 * fail-closed egress gateway all live there).
 */
export function createResendTransport(opts: {
  apiKey: string;
  env?: Record<string, string | undefined>;
}): EmailTransport {
  return {
    providerKind: DEFAULT_EMAIL_PROVIDER_KIND,
    send(message) {
      return postResendEmail({
        apiKey: opts.apiKey,
        fromEmail: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
        idempotencyKey: message.idempotencyKey,
        attachments: message.attachments,
        signal: message.signal,
        env: opts.env,
      });
    },
  };
}

/**
 * Resolve the Resend API key for a Node composition root.
 *
 * Both environments have a key and both are valid; only the variable NAME
 * differs, because the two Vercel projects are provisioned separately:
 *
 *   the production project → RESEND_API_KEY
 *   the staging project    → RESEND_SANDBOX_API_KEY
 *
 * The concrete project names are in docs/SECRETS.md, deliberately not repeated
 * here: this file is a publishable reference adapter and a product name in it is
 * counted vocabulary.
 *
 * A composition root that reads only `RESEND_API_KEY` therefore starts with an
 * empty key on staging, and every send fails with the provider's "API key is
 * invalid" — which reads like a revoked credential rather than a missing binding
 * and sends the reader looking for a key that was there all along. Prefer the
 * production name so production behaviour is unchanged, and fall back to the
 * staging name rather than requiring staging to be given a production variable:
 * its absence there is a deliberate control against mailing real customers from
 * a preview deployment.
 */
export function resolveEmailApiKey(env: Record<string, string | undefined> = process.env): string {
  const primary = (env.RESEND_API_KEY ?? "").trim();
  return primary || (env.RESEND_SANDBOX_API_KEY ?? "").trim();
}

/** Default concrete binding exposed to Node composition roots. */
export const createEmailTransport = createResendTransport;

export interface InMemoryEmailTransport extends EmailTransport {
  /** Every message handed to send(), in order — for tests and dry runs. */
  readonly sent: ReadonlyArray<EmailMessage>;
}

/**
 * Non-Resend reference transport: captures sends in memory and never makes a
 * network call. Proves the seam is real — a port wired to this sends email with
 * zero Resend references — and doubles as the substitute an OSS fork starts from
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
