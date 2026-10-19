import {
  classifyEmailSendOutcome,
  type EmailSendOutcomeLike,
} from "../../infra/email/emailTransport.js";

export type EmailDeliveryTimelineStatus =
  | "planned"
  | "queued"
  | "blocked"
  | "skipped"
  | "processing"
  | "sent"
  | "delivered"
  | "delivery_delayed"
  | "bounced"
  | "complained"
  | "failed"
  | "missed"
  | "legacy_unlinked";

export type EmailDeliveryPurpose =
  | "transactional"
  | "tester_program"
  | "marketing_launch_offer"
  | "marketing_newsletter"
  | "subscription_dunning"
  | "admin_notification";

export interface EmailDeliveryTimelineClient {
  rpc?(
    name: string,
    params: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface EmailDeliveryTimelineInput {
  dedupeKey: string;
  templateSlug: string;
  purpose: EmailDeliveryPurpose;
  triggerSource: string;
  triggerEvent: string;
  status: EmailDeliveryTimelineStatus;
  recipientEmail?: string | null;
  clientId?: string | null;
  authUserId?: string | null;
  aggregateType?: string | null;
  aggregateId?: string | null;
  outboxEventId?: string | null;
  platformJobRunId?: string | null;
  scheduledDueAt?: string | null;
  expectedSendAt?: string | null;
  decisionId?: string | null;
  emailSendId?: string | null;
  providerKind?: string | null;
  providerMessageId?: string | null;
  lastErrorCode?: string | null;
  metadata?: Record<string, unknown>;
}

export interface EmailDeliveryTimelineOptions {
  required?: boolean;
  context?: string;
}

export class EmailDeliveryTimelineError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "EmailDeliveryTimelineError";
    this.cause = cause;
  }
}

/**
 * The diagnostic context for a timeline write that did not land.
 *
 * An ALLOWLIST, never a redaction of `input`. Both callers below are the
 * best-effort branch, so a failure here is silent by design — the only thing an
 * operator ever gets is this line, and until it existed the line named no
 * template, no trigger, no aggregate and no error code. On production it fires
 * several times a day from the live payment webhook, which meant a real
 * customer's send was being lost with nothing to identify it by.
 *
 * What is deliberately NOT here, and why the shape must stay an allowlist:
 * - `recipientEmail` — the personal field; the whole reason a spread is unsafe.
 * - `dedupeKey` — every builder is id-based today (`outbox:<uuid>`,
 *   `subscription-dunning:<id>`), but the field is typed as a bare `string`, so
 *   that is a property of today's callers rather than of the contract.
 *   `aggregateId` and `outboxEventId` already identify the row.
 * - `metadata` — free-form caller data.
 * - every error field except a code — the database driver puts row values in
 *   `message`/`details`/`hint`, which is exactly how an address reaches a log.
 *
 * Adding a field here is a privacy decision. `never logs personal data` in the
 * sibling test fails loudly if this becomes a spread.
 */
function timelineFailureContext(
  input: EmailDeliveryTimelineInput,
  context: string,
  error?: unknown,
): Record<string, unknown> {
  return {
    context: context === "" ? null : context.replace(/^:/, ""),
    templateSlug: input.templateSlug,
    purpose: input.purpose,
    triggerSource: input.triggerSource,
    triggerEvent: input.triggerEvent,
    status: input.status,
    aggregateType: input.aggregateType ?? null,
    aggregateId: input.aggregateId ?? null,
    outboxEventId: input.outboxEventId ?? null,
    errorCode: errorCodeOf(error),
  };
}

/** The code alone. Never the message, details, or hint — see above. */
function errorCodeOf(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code.length > 0) return code;
  if (typeof code === "number") return String(code);
  return null;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What may reach `p_platform_job_run_id`, and where the rest is kept.
 *
 * That parameter is declared `uuid` and the column it writes has a foreign key
 * to `platform_job_runs`, so PostgREST casts the argument before the function
 * body runs. Callers that lease a real run pass its id; one caller passes a
 * dispatch label instead, and from 2026-08-18 that label failed the cast with
 * 22P02 on every payment-webhook mail — twice per mail, at `processing` and at
 * `sent` — which lost the whole attempt record for the two money-path mails.
 *
 * So: a uuid-shaped value goes to the column, anything else non-empty goes to
 * `p_metadata` under `platformJobRunId`, and the column gets `null`. A key the
 * caller already set there wins, because the caller's own metadata is the more
 * specific statement; the two money-path ports spread their origin metadata
 * into this call, so for them the key is already present and the merge below
 * is a belt for callers that do not. The evidence reader
 * (`server/domains/platform/emailObservabilityEvidence.ts`) reads the label
 * from `email_sends.provider_response`, which the ports fill on their own
 * path, untouched by this guard. The shape test is the same one the
 * reward-confirmation outbox view applies to
 * `provider_response->>'platformJobRunId'`, so both readings agree. It is a
 * shape test, not an existence test: a uuid of a run that never existed would
 * still fail the foreign key; today every uuid producer is a lease.
 *
 * Deliberately silent: a warning here would fire on every money-path mail and
 * replace one daily noise with another. The contract is this comment plus the
 * sibling test.
 */
function runIdAndMetadata(input: EmailDeliveryTimelineInput): {
  platformJobRunId: string | null;
  metadata: Record<string, unknown>;
} {
  const raw = input.platformJobRunId ?? null;
  const metadata = input.metadata ?? {};
  if (raw !== null && UUID_SHAPE.test(raw)) {
    return { platformJobRunId: raw, metadata };
  }
  if (raw === null || raw === "" || "platformJobRunId" in metadata) {
    return { platformJobRunId: null, metadata };
  }
  return { platformJobRunId: null, metadata: { ...metadata, platformJobRunId: raw } };
}

export function outboxDeliveryDedupeKey(outboxEventId: string): string {
  return `outbox:${outboxEventId}`;
}

export function commerceOrderAggregateId(orderId: string): string {
  return orderId.startsWith("order_") ? orderId.slice("order_".length) : orderId;
}

export function statusFromSendOutcome(outcome: EmailSendOutcomeLike): {
  status: EmailDeliveryTimelineStatus;
  lastErrorCode: string | null;
} {
  const projected = classifyEmailSendOutcome(outcome);
  return { status: projected.timelineStatus, lastErrorCode: projected.lastErrorCode };
}

export async function recordEmailDeliveryTimeline(
  client: EmailDeliveryTimelineClient,
  input: EmailDeliveryTimelineInput,
  options: EmailDeliveryTimelineOptions = {},
): Promise<string | null> {
  const context = options.context ? `:${options.context}` : "";
  if (!client.rpc) {
    if (options.required) {
      throw new EmailDeliveryTimelineError(`email_delivery_timeline_rpc_missing${context}`);
    }
    return null;
  }
  const runId = runIdAndMetadata(input);
  try {
    const result = await client.rpc("communication_record_email_delivery", {
      p_dedupe_key: input.dedupeKey,
      p_template_slug: input.templateSlug,
      p_purpose: input.purpose,
      p_trigger_source: input.triggerSource,
      p_trigger_event: input.triggerEvent,
      p_status: input.status,
      p_recipient_email: input.recipientEmail ?? null,
      p_contact_id: null,
      p_client_id: input.clientId ?? null,
      p_auth_user_id: input.authUserId ?? null,
      p_aggregate_type: input.aggregateType ?? null,
      p_aggregate_id: input.aggregateId ?? null,
      p_outbox_event_id: input.outboxEventId ?? null,
      p_platform_job_run_id: runId.platformJobRunId,
      p_scheduled_due_at: input.scheduledDueAt ?? null,
      p_expected_send_at: input.expectedSendAt ?? null,
      p_decision_id: input.decisionId ?? null,
      p_email_send_id: input.emailSendId ?? null,
      p_provider_kind: input.providerKind ?? "resend",
      p_provider_message_id: input.providerMessageId ?? null,
      p_last_error_code: input.lastErrorCode ?? null,
      p_metadata: runId.metadata,
    });
    if (result.error) {
      if (options.required) {
        throw new EmailDeliveryTimelineError(`email_delivery_timeline_rpc_error${context}`, result.error);
      }
      console.error(
        "[email-delivery-timeline] record RPC returned error",
        timelineFailureContext(input, context, result.error),
      );
      return null;
    }
    if (typeof result.data === "string" && result.data.length > 0) {
      return result.data;
    }
    if (options.required) {
      throw new EmailDeliveryTimelineError(`email_delivery_timeline_id_missing${context}`, result.data);
    }
    return null;
  } catch (err) {
    if (err instanceof EmailDeliveryTimelineError) {
      throw err;
    }
    if (options.required) {
      throw new EmailDeliveryTimelineError(`email_delivery_timeline_rpc_threw${context}`, err);
    }
    console.error(
      "[email-delivery-timeline] record RPC threw",
      timelineFailureContext(input, context, err),
    );
    return null;
  }
}
