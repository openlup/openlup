import {
  classifyEmailSendOutcome,
  emailTransportLedgerIdentifier,
  emailTransportMessageId,
  failedEmailTransportResult,
  type EmailSendResult,
  type EmailTransport,
} from "../../infra/email/emailTransport.js";
import type {
  PublicIntakeDeliveryMessage,
  PublicIntakeDeliveryPort,
  PublicIntakeDeliveryResult,
  PublicIntakePolicyDecision,
  PublicIntakeRecipientKind,
} from "../../domains/communications/ports.js";

export interface PublicIntakeEmailDeliveryClient {
  rpc?(name: string, params: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: "email_sends"): PublicIntakeEmailSendsQuery;
}

export interface PublicIntakeEmailSendsQuery {
  insert(row: Record<string, unknown>):
    | PromiseLike<{ error: unknown }>
    | { select(columns: "id"): { maybeSingle(): PromiseLike<{ data: { id?: string } | null; error: unknown }> } };
}

export function createPublicIntakeEmailDeliveryPort(input: {
  client: PublicIntakeEmailDeliveryClient;
  transport: EmailTransport;
}): PublicIntakeDeliveryPort {
  const { client, transport } = input;
  return {
    async evaluatePolicy(policyInput) {
      if (!policyInput.email?.trim()) return { allowed: false, reason: "missing_email", decisionId: null };
      if (!client.rpc) return policyFallback(policyInput.recipientKind, "policy_rpc_unavailable");
      try {
        const { data, error } = await client.rpc("communication_evaluate_email_policy", {
          p_email: policyInput.email,
          p_purpose: policyInput.purpose,
          p_source: policyInput.source,
          p_recipient_kind: policyInput.recipientKind,
          p_source_table: policyInput.sourceTable ?? null,
          p_source_id: policyInput.sourceId ?? null,
          p_metadata: policyInput.metadata,
        });
        if (error) return policyFallback(policyInput.recipientKind, "policy_evaluate_failed");
        return readPolicy(data) ?? policyFallback(policyInput.recipientKind, "policy_response_unreadable");
      } catch {
        return policyFallback(policyInput.recipientKind, "policy_evaluate_threw");
      }
    },

    async deliver(delivery) {
      const result = await send(transport, delivery.message, delivery.dedupeKey);
      const messageId = emailTransportMessageId(result.outcome);
      const evidence = projectEvidence(result.outcome, messageId);
      const timeline = {
        dedupeKey: delivery.dedupeKey,
        templateSlug: delivery.templateSlug,
        purpose: delivery.purpose,
        triggerSource: delivery.source,
        triggerEvent: delivery.triggerEvent,
        status: evidence.timelineStatus,
        recipientEmail: delivery.recipientEmail,
        aggregateType: delivery.aggregateType,
        aggregateId: delivery.aggregateId,
        decisionId: delivery.policyDecisionId,
        providerKind: transport.providerKind,
        messageId,
        lastErrorCode: evidence.lastErrorCode,
        metadata: delivery.metadata ?? {},
      } as const;
      const sendAttemptId = await recordTimeline(client, timeline);
      const emailSendId = await recordAttempt(client, { delivery, result, messageId, evidence, sendAttemptId });
      if (delivery.policyDecisionId && emailSendId && client.rpc) {
        try {
          await client.rpc("communication_link_send_decision", {
            p_decision_id: delivery.policyDecisionId,
            p_email_send_id: emailSendId,
            p_provider_message_id: messageId,
          });
        } catch {
          // The delivery has already happened; linking is observational only.
        }
      }
      if (sendAttemptId && emailSendId) await recordTimeline(client, { ...timeline, emailSendId });
      return deliveryResult(evidence, messageId);
    },
  };
}

async function send(transport: EmailTransport, message: PublicIntakeDeliveryMessage, dedupeKey: string): Promise<EmailSendResult> {
  try {
    return await transport.send({ from: message.sender, to: message.to, subject: message.subject, html: message.html, text: message.text, replyTo: message.replyTo, idempotencyKey: dedupeKey });
  } catch {
    return failedEmailTransportResult();
  }
}

function readPolicy(value: unknown): PublicIntakePolicyDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return { allowed: row.allowed === true, reason: typeof row.reason === "string" ? row.reason : "unknown", decisionId: typeof row.decisionId === "string" ? row.decisionId : null };
}

function policyFallback(recipientKind: PublicIntakeRecipientKind, reason: string): PublicIntakePolicyDecision {
  const allowed = recipientKind === "admin_internal";
  return { allowed, reason: `${reason}_${allowed ? "fail_open_with_audit" : "fail_closed"}`, decisionId: null };
}

function projectEvidence(outcome: EmailSendResult["outcome"], messageId: string | null) {
  const classified = classifyEmailSendOutcome(outcome);
  if (!outcome.ok || messageId || classified.skipReason) return classified;
  return { ...classified, timelineStatus: "delivery_delayed" as const, ledgerStatus: "failed" as const, sentAtEligible: false, lastErrorCode: "provider_accepted_without_message_id" };
}

async function recordTimeline(client: PublicIntakeEmailDeliveryClient, input: {
  dedupeKey: string; templateSlug: string; purpose: "transactional" | "admin_notification"; triggerSource: string; triggerEvent: string;
  status: "sent" | "skipped" | "delivery_delayed" | "failed"; recipientEmail: string; aggregateType: string; aggregateId: string;
  decisionId: string | null; providerKind: string; messageId: string | null; lastErrorCode: string | null; metadata: Record<string, unknown>; emailSendId?: string;
}): Promise<string | null> {
  if (!client.rpc) return null;
  try {
    const { data, error } = await client.rpc("communication_record_email_delivery", {
      p_dedupe_key: input.dedupeKey, p_template_slug: input.templateSlug, p_purpose: input.purpose,
      p_trigger_source: input.triggerSource, p_trigger_event: input.triggerEvent, p_status: input.status,
      p_recipient_email: input.recipientEmail, p_contact_id: null, p_client_id: null, p_auth_user_id: null,
      p_aggregate_type: input.aggregateType, p_aggregate_id: input.aggregateId, p_outbox_event_id: null,
      p_platform_job_run_id: null, p_scheduled_due_at: null, p_expected_send_at: null,
      p_decision_id: input.decisionId, p_email_send_id: input.emailSendId ?? null,
      p_provider_kind: input.providerKind, p_provider_message_id: input.messageId,
      p_last_error_code: input.lastErrorCode, p_metadata: input.metadata,
    });
    return error || typeof data !== "string" || !data ? null : data;
  } catch {
    return null;
  }
}

async function recordAttempt(client: PublicIntakeEmailDeliveryClient, input: {
  delivery: Parameters<PublicIntakeDeliveryPort["deliver"]>[0]; result: EmailSendResult; messageId: string | null;
  evidence: ReturnType<typeof projectEvidence>; sendAttemptId: string | null;
}): Promise<string | null> {
  try {
    const inserted = client.from("email_sends").insert({
      tester_id: null, template_slug: input.delivery.templateSlug, source: input.delivery.source, ...emailTransportLedgerIdentifier(input.messageId),
      status: input.evidence.ledgerStatus, sent_at: input.evidence.sentAtEligible ? new Date().toISOString() : null,
      provider_error: input.evidence.lastErrorCode,
      provider_response: {
        ...input.result.providerResponse,
        triggerSource: input.delivery.source,
        triggerReason: input.delivery.templateSlug,
        outboxEventId: input.delivery.dedupeKey,
        ...(typeof input.delivery.metadata?.policyReason === "string" ? { policyReason: input.delivery.metadata.policyReason } : {}),
        ...(input.sendAttemptId ? { sendAttemptId: input.sendAttemptId } : { sendAttemptLink: "timeline_unavailable" }),
      },
    });
    if (hasInsertSelect(inserted)) {
      const result = await inserted.select("id").maybeSingle();
      return result.error || typeof result.data?.id !== "string" || !result.data.id ? null : result.data.id;
    }
    await inserted;
  } catch {
    // Evidence is best effort after the public intake's durable write.
  }
  return null;
}

function hasInsertSelect(value: ReturnType<PublicIntakeEmailSendsQuery["insert"]>): value is Extract<ReturnType<PublicIntakeEmailSendsQuery["insert"]>, { select(columns: "id"): unknown }> {
  return typeof value === "object" && value !== null && "select" in value && typeof value.select === "function";
}

function deliveryResult(evidence: ReturnType<typeof projectEvidence>, messageId: string | null): PublicIntakeDeliveryResult {
  const accepted = evidence.ledgerStatus === "sent" && Boolean(messageId);
  return { accepted, messageId: accepted ? messageId : null, skip: evidence.ledgerStatus === "skipped" ? evidence.lastErrorCode : null, error: accepted || evidence.ledgerStatus === "skipped" ? null : evidence.lastErrorCode };
}
