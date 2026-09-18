// Generic marketing Resend port (Node): one direct Resend POST + one sanitized
// email_sends ledger row per attempt, source 'marketing-dispatch'. Unlike the
// transactional port it is template-agnostic — the caller renders the email and
// passes {to, subject, html, text, templateSlug, outboxEventId}. No email body,
// recipient payload, or template variables are ever stored (email_sends column
// comment contract): provider_response holds only {id} + outboxEventId. When a
// consent decisionId is supplied the send is linked to its policy decision via
// communication_link_send_decision for the audit trail.

import {
  outboxDeliveryDedupeKey,
  recordEmailDeliveryTimeline,
  statusFromSendOutcome,
} from "./emailDeliveryTimeline.js";
import { type ResendEmailSendOutcome } from "../../infra/resend/resendEmailClient.js";
import {
  classifyEmailSendOutcome,
  createResendTransport,
  type EmailSendSkipReason,
  type EmailTransport,
} from "../../infra/email/emailTransport.js";
import { logEmailLedgerInsertFailure } from "./emailLedgerLog.js";
import { buildEmailOriginMetadata, withEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import {
  EMAIL_NOTIFICATION_ADMIN_DISABLED,
  createEmailNotificationControlPort,
} from "../../infra/email/emailNotificationControl.js";

export const MARKETING_DISPATCH_EMAIL_SOURCE = "marketing-dispatch";

export interface MarketingEmailSupabaseClient {
  from(table: string): MarketingEmailSendsQueryBuilder;
  rpc?(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

interface MarketingEmailSendsQueryBuilder {
  select(columns: string): MarketingEmailSendsQueryBuilder;
  eq(column: string, value: unknown): MarketingEmailSendsQueryBuilder;
  neq(column: string, value: unknown): MarketingEmailSendsQueryBuilder;
  limit(
    count: number,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  insert(row: Record<string, unknown>): MarketingEmailInsertBuilder;
}

interface MarketingEmailInsertBuilder {
  select(columns: string): MarketingEmailInsertBuilder;
  limit(
    count: number,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export interface MarketingEmailSendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  templateSlug: string;
  outboxEventId: string;
  decisionId?: string | null;
  /** Optional abort signal so a worker timeout can cancel an in-flight POST. */
  signal?: AbortSignal;
}

export type MarketingEmailSendOutcome = ResendEmailSendOutcome & {
  skipReason?: EmailSendSkipReason | null;
};

export interface MarketingEmailPort {
  findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean>;
  send(input: MarketingEmailSendInput): Promise<MarketingEmailSendOutcome>;
}

export function createResendMarketingEmailPort(config: {
  apiKey: string;
  fromEmail: string;
  client: MarketingEmailSupabaseClient;
  emailBaseUrl?: string | null;
  emailOriginSource?: string | null;
  emailEnvironment?: string | null;
  platformJobRunId?: string | null;
  transport?: EmailTransport;
}): MarketingEmailPort {
  const { apiKey, fromEmail, client } = config;
  const transport = config.transport ?? createResendTransport({ apiKey, env: process.env });
  const platformJobRunId = config.platformJobRunId ?? null;
  const controlPort = createEmailNotificationControlPort(client as never);
  const originMetadata = buildEmailOriginMetadata({
    baseUrl: config.emailBaseUrl,
    originSource: config.emailOriginSource,
    environment: config.emailEnvironment,
    platformJobRunId,
  });

  // Returns the inserted email_sends row id (for decision linkage), or null.
  async function logAttempt(
    input: MarketingEmailSendInput,
    outcome: MarketingEmailSendOutcome,
    providerResponse: Record<string, unknown>,
    sendAttemptId: string | null,
  ): Promise<string | null> {
    const projected = classifyEmailSendOutcome(outcome);
    try {
      const result = await client
        .from("email_sends")
        .insert({
          tester_id: null,
          template_slug: input.templateSlug,
          source: MARKETING_DISPATCH_EMAIL_SOURCE,
          resend_id: outcome.resendId,
          status: projected.ledgerStatus,
          sent_at: projected.sentAtEligible ? new Date().toISOString() : null,
          provider_error: outcome.providerError,
          provider_response: withEmailOriginMetadata(providerResponse, originMetadata, {
            triggerSource: MARKETING_DISPATCH_EMAIL_SOURCE,
            triggerReason: input.templateSlug,
            outboxEventId: input.outboxEventId,
            ...(sendAttemptId
              ? { sendAttemptId }
              : { sendAttemptLink: "timeline_unavailable" }),
          }),
        })
        .select("id")
        .limit(1);
      if (result.error) {
        logEmailLedgerInsertFailure({ source: MARKETING_DISPATCH_EMAIL_SOURCE, templateSlug: input.templateSlug, error: result.error });
        return null;
      }
      const rows = result.data;
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0] as Record<string, unknown>;
        return typeof row.id === "string" ? row.id : null;
      }
      return null;
    } catch (err) {
      logEmailLedgerInsertFailure({ source: MARKETING_DISPATCH_EMAIL_SOURCE, templateSlug: input.templateSlug, error: err });
      return null;
    }
  }

  async function logSkippedAttempt(input: MarketingEmailSendInput, sendAttemptId: string | null): Promise<string | null> {
    try {
      const result = await client
        .from("email_sends")
        .insert({
          tester_id: null,
          template_slug: input.templateSlug,
          source: MARKETING_DISPATCH_EMAIL_SOURCE,
          resend_id: null,
          status: "skipped",
          sent_at: null,
          provider_error: null,
          provider_response: withEmailOriginMetadata(
            { skipped: EMAIL_NOTIFICATION_ADMIN_DISABLED },
            originMetadata,
            {
              triggerSource: MARKETING_DISPATCH_EMAIL_SOURCE,
              triggerReason: input.templateSlug,
              outboxEventId: input.outboxEventId,
              ...(sendAttemptId ? { sendAttemptId } : { sendAttemptLink: "timeline_unavailable" }),
            },
          ),
        })
        .select("id")
        .limit(1);
      if (result.error) {
        logEmailLedgerInsertFailure({ source: MARKETING_DISPATCH_EMAIL_SOURCE, templateSlug: input.templateSlug, error: result.error });
        return null;
      }
      const rows = result.data;
      if (Array.isArray(rows) && rows.length > 0) {
        const row = rows[0] as Record<string, unknown>;
        return typeof row.id === "string" ? row.id : null;
      }
      return null;
    } catch (err) {
      logEmailLedgerInsertFailure({ source: MARKETING_DISPATCH_EMAIL_SOURCE, templateSlug: input.templateSlug, error: err });
      return null;
    }
  }

  async function linkDecision(
    decisionId: string,
    emailSendId: string,
    providerMessageId: string | null,
  ): Promise<void> {
    if (!client.rpc) return;
    try {
      await client.rpc("communication_link_send_decision", {
        p_decision_id: decisionId,
        p_email_send_id: emailSendId,
        p_provider_message_id: providerMessageId,
      });
    } catch {
      // Audit linkage is best-effort; never break delivery.
    }
  }

  async function recordTimeline(
    input: MarketingEmailSendInput,
    status: "processing" | "sent" | "failed" | "delivery_delayed" | "skipped",
    outcome?: MarketingEmailSendOutcome,
    emailSendId?: string | null,
  ): Promise<string | null> {
    const projected = outcome ? classifyEmailSendOutcome(outcome) : null;
    const skipReason = projected?.skipReason
      ?? (status === "skipped" ? EMAIL_NOTIFICATION_ADMIN_DISABLED : null);
    return recordEmailDeliveryTimeline(client, {
      dedupeKey: outboxDeliveryDedupeKey(input.outboxEventId),
      templateSlug: input.templateSlug,
      purpose: "marketing_newsletter",
      triggerSource: MARKETING_DISPATCH_EMAIL_SOURCE,
      triggerEvent: "marketing_dispatch_send",
      status,
      recipientEmail: input.to,
      outboxEventId: input.outboxEventId,
      platformJobRunId,
      decisionId: input.decisionId ?? null,
      emailSendId: emailSendId ?? null,
      providerKind: transport.providerKind,
      providerMessageId: outcome?.resendId ?? null,
      lastErrorCode: projected?.lastErrorCode ?? skipReason,
      metadata: {
        adapter: "marketing",
        ...originMetadata,
        ...(skipReason ? { skipped: skipReason } : {}),
      },
    }, {
      required: false,
      context: `${MARKETING_DISPATCH_EMAIL_SOURCE}:${input.templateSlug}`,
    });
  }

  return {
    async findExistingSend(templateSlug: string, outboxEventId: string): Promise<boolean> {
      const result = await client
        .from("email_sends")
        .select("id")
        .eq("template_slug", templateSlug)
        .neq("status", "failed")
        .neq("status", "skipped")
        .eq("provider_response->>outboxEventId", outboxEventId)
        .limit(1);
      if (result.error) {
        throw new Error(
          `marketing_email_dedupe_read_failed: ${result.error.message ?? result.error.code ?? "unknown"}`,
        );
      }
      return Array.isArray(result.data) && result.data.length > 0;
    },

    async send(input: MarketingEmailSendInput): Promise<MarketingEmailSendOutcome> {
      const enabled = await controlPort.isEnabled(input.templateSlug, input.signal ?? new AbortController().signal);
      if (!enabled) {
        const sendAttemptId = await recordTimeline(input, "skipped");
        const emailSendId = await logSkippedAttempt(input, sendAttemptId);
        if (input.decisionId && emailSendId) {
          await linkDecision(input.decisionId, emailSendId, null);
        }
        return {
          ok: true,
          resendId: null,
          httpStatus: 0,
          providerError: null,
          aborted: false,
          skipReason: "admin_disabled",
        };
      }
      const sendAttemptId = await recordTimeline(input, "processing");
      const { outcome: rawOutcome, providerResponse } = await transport.send({
        from: fromEmail,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        idempotencyKey: outboxDeliveryDedupeKey(input.outboxEventId),
        signal: input.signal,
      });
      const skipReason = classifyEmailSendOutcome(rawOutcome).skipReason;
      const outcome = skipReason ? { ...rawOutcome, skipReason } : rawOutcome;
      const emailSendId = await logAttempt(input, outcome, providerResponse, sendAttemptId);
      if (input.decisionId && emailSendId) {
        await linkDecision(input.decisionId, emailSendId, outcome.resendId);
      }
      const mapped = statusFromSendOutcome(outcome);
      await recordTimeline(input, mapped.status as "sent" | "failed" | "delivery_delayed", outcome, emailSendId);
      return outcome;
    },
  };
}
