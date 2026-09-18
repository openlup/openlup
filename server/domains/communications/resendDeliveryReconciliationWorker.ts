/**
 * Resend delivery reconciliation (docs/platform/RUNTIME_AND_SELF_HOSTING.md Wave 4).
 *
 * Delivery status was WEBHOOK-ONLY: if a Resend webhook is dropped, the
 * email_sends row freezes at `sent` and the delivery timeline never closes —
 * the `email_webhook_gap` detector counts exactly these. This worker polls the
 * provider for frozen sends and asks the atomic
 * communication_update_email_delivery_from_provider RPC to apply the same
 * transitions the webhook would.
 *
 * A polled complaint carries the provider-returned recipient into the same
 * atomic RPC as the webhook, so suppression remains replay-safe without a
 * second application-side writer.
 */

// Normalizes the provider read snapshot into the event type understood by the
// atomic RPC. Unknown snapshots stay ignored defensively.
const LAST_EVENT_TO_WEBHOOK_TYPE: Record<string, string> = {
  sent: "email.sent",
  delivered: "email.delivered",
  delivery_delayed: "email.delivery_delayed",
  bounced: "email.bounced",
  complained: "email.complained",
  failed: "email.failed",
};

export interface FrozenSendRow {
  id: string;
  resendId: string;
  status: string | null;
}

export interface ResendEmailStatusRead {
  ok: boolean;
  lastEvent: string | null;
  recipientEmail: string | null;
  // HTTP status of the provider read (0 = network/exception). Threaded through so
  // an operator can tell stale-id 404s from auth (401/403) or outage (5xx).
  httpStatus: number;
  // Short sanitized provider error message; null on success.
  providerError: string | null;
}

export interface ResendDeliveryReconciliationPort {
  findFrozenSends(input: { now: string; graceMinutes: number; limit: number }): Promise<FrozenSendRow[]>;
  applyPolledEvent(input: {
    sendId: string;
    resendId: string;
    // 'email.*' provider event type for the atomic delivery RPC.
    webhookType: string;
    eventAt: string;
    recipientEmail: string | null;
  }): Promise<void>;
  // Rotates every non-404 provider read to the back of the bounded candidate
  // window and clears any earlier consecutive-404 evidence.
  recordPollAttempt(input: { sendId: string; attemptedAt: string }): Promise<void>;
  // Records a provider 404 for a send and abandons it (durable marker) once the
  // consecutive-404 count reaches the threshold. Returns whether THIS call newly
  // abandoned the send, so the worker counts each abandonment once.
  recordSendNotFound(input: { sendId: string; threshold: number }): Promise<{ abandoned: boolean }>;
}

// After this many consecutive provider 404s, a frozen send is given up as
// un-pollable and excluded from re-polling. With an adopter-configured polling lag of at most 30 minutes this is
// ~1.5h of 404s on a send already >=45min old — unambiguous that the id is
// permanently unreadable by the polling account (wrong-account or purged).
export const POLL_ABANDON_AFTER_NOT_FOUND = 3;

// Bounded histogram of read-failure classes (counts only, never per-send rows).
export interface ResendReadFailureBreakdown {
  notFound: number;
  authFailed: number;
  network: number;
  providerError: number;
  other: number;
}

export interface ResendDeliveryReconciliationResult {
  checked: number;
  reconciled: number;
  stillPending: number;
  terminalPolled: number;
  failures: number;
  // Sends given up as un-pollable this run (crossed the 404 abandon threshold).
  abandoned: number;
  // Breakdown of the `failures` count by provider read-failure class.
  failureBreakdown: ResendReadFailureBreakdown;
}

function classifyReadFailure(breakdown: ResendReadFailureBreakdown, httpStatus: number): void {
  if (httpStatus === 404) breakdown.notFound += 1;
  else if (httpStatus === 401 || httpStatus === 403) breakdown.authFailed += 1;
  else if (httpStatus === 0) breakdown.network += 1;
  else if (httpStatus >= 500 && httpStatus <= 599) breakdown.providerError += 1;
  else breakdown.other += 1;
}

export async function runResendDeliveryReconciliation(input: {
  port: ResendDeliveryReconciliationPort;
  // Injected provider reader (server/infra stays out of domain imports); the
  // cron route wires getResendEmail from the resend client here.
  readEmail: (resendId: string) => Promise<ResendEmailStatusRead>;
  now: string;
  graceMinutes: number;
  limit: number;
}): Promise<ResendDeliveryReconciliationResult> {
  const result: ResendDeliveryReconciliationResult = {
    checked: 0,
    reconciled: 0,
    stillPending: 0,
    terminalPolled: 0,
    failures: 0,
    abandoned: 0,
    failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0 },
  };

  const frozen = await input.port.findFrozenSends({
    now: input.now,
    graceMinutes: input.graceMinutes,
    limit: input.limit,
  });

  for (const send of frozen) {
    result.checked += 1;
    const read = await input.readEmail(send.resendId);
    // The 404 path records the same timestamp together with its consecutive
    // not-found count in recordSendNotFound. Every other read rotates directly.
    if (read.httpStatus !== 404) {
      try {
        await input.port.recordPollAttempt({ sendId: send.id, attemptedAt: input.now });
      } catch {
        // Rotation is fairness bookkeeping, not authority over provider truth.
        // Keep applying a terminal observation even when this write fails.
        result.failures += 1;
      }
    }
    if (!read.ok) {
      result.failures += 1;
      classifyReadFailure(result.failureBreakdown, read.httpStatus);
      // Only a 404 is terminal for a specific id (unreadable by this account /
      // purged). Auth (401/403), network (0), and outage (5xx) are systemic or
      // transient — abandoning on them would hide real gaps, so they only feed
      // the histogram.
      if (read.httpStatus === 404) {
        const { abandoned } = await input.port.recordSendNotFound({
          sendId: send.id,
          threshold: POLL_ABANDON_AFTER_NOT_FOUND,
        });
        if (abandoned) result.abandoned += 1;
      }
      continue;
    }
    const webhookType = read.lastEvent ? LAST_EVENT_TO_WEBHOOK_TYPE[read.lastEvent] ?? null : null;
    if (!webhookType || webhookType === "email.sent") {
      // Provider still says only "sent": nothing to reconcile yet.
      result.stillPending += 1;
      continue;
    }
    try {
      await input.port.applyPolledEvent({
        sendId: send.id,
        resendId: send.resendId,
        webhookType,
        eventAt: input.now,
        recipientEmail: read.recipientEmail,
      });
      result.reconciled += 1;
      if (["email.bounced", "email.complained", "email.failed"].includes(webhookType)) {
        result.terminalPolled += 1;
      }
    } catch {
      result.failures += 1;
    }
  }

  return result;
}
