import type { ResearchSurveySubmitRequest, ResearchSurveySubmitResponse } from "@openlup/core/marketing/research";
import type { PublicIntakeDeliveryPort, PublicIntakeDeliveryResult } from "../../../communications/contracts/index.js";

type SurveyTable = "survey_responses_producer" | "survey_responses_consumer";

export interface ManagedSurveyResponseGateway {
  checkRateLimit(input: {
    table: SurveyTable;
    ip: string;
    windowMinutes: number;
    maxPerIp: number;
    now: Date;
  }): Promise<"allowed" | "limited" | "unavailable">;
  insert(input: {
    table: SurveyTable;
    responseData: Record<string, unknown>;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ id: string } | null>;
  updateEmailStatus(input: {
    table: SurveyTable;
    id: string;
    sentAt: string | null;
    error: string | null;
  }): Promise<void>;
}

export interface ManagedSurveyResponseSubmitDeps {
  renderNotificationHtml: (surveyType: "producer" | "consumer", responseData: Record<string, unknown>, id: string) => string;
  notificationSubject: (surveyType: "producer" | "consumer", now: Date) => string;
  gateway: ManagedSurveyResponseGateway;
  delivery: PublicIntakeDeliveryPort;
  notifyTo: string[];
  fromEmail: string;
  windowMinutes: number;
  maxPerIp: number;
  now?: () => Date;
}

export function createManagedSurveyResponseSubmit(deps: ManagedSurveyResponseSubmitDeps) {
  const now = deps.now ?? (() => new Date());
  return async (request: ResearchSurveySubmitRequest, headers?: Headers): Promise<ResearchSurveySubmitResponse> => {
    if (!validRequest(request)) return { ok: false, error: "invalid_response_data" };
    const table = request.surveyType === "producer" ? "survey_responses_producer" : "survey_responses_consumer";
    const ip = readIp(headers);
    const rate = await deps.gateway.checkRateLimit({ table, ip: ip ?? "unknown", windowMinutes: deps.windowMinutes, maxPerIp: deps.maxPerIp, now: now() });
    if (rate === "unavailable") return { ok: false, error: "survey_rate_limit_unavailable" };
    if (rate === "limited") return { ok: false, error: "survey_rate_limited" };

    let inserted: { id: string } | null;
    try {
      inserted = await deps.gateway.insert({
        table,
        responseData: request.responseData,
        ip,
        userAgent: headers?.get("user-agent") || null,
      });
    } catch {
      inserted = null;
    }
    if (!inserted) return { ok: false, error: "db_insert_failed" };

    if (deps.notifyTo.length === 0) {
      await updateEmailStatus(deps.gateway, table, inserted.id, null, "notification_recipient_not_configured");
      return { ok: true, id: inserted.id, email_skipped: "notification_recipient_not_configured" };
    }

    const templateSlug = `survey_${request.surveyType}_notification`;
    const policies = await Promise.all(deps.notifyTo.map((recipient, index) => deps.delivery.evaluatePolicy({
      email: recipient,
      purpose: "admin_notification",
      source: "submit-survey-response",
      recipientKind: "admin_internal",
      metadata: {
        template_slug: templateSlug,
        survey_type: request.surveyType,
        survey_response_id: inserted.id,
        recipient_count: deps.notifyTo.length,
        recipient_index: index,
      },
    })));
    const recipients = deps.notifyTo.map((recipient, index) => ({ recipient, index, policy: policies[index]! }));
    const allowedRecipients = recipients.filter(({ policy }) => policy.allowed);
    if (allowedRecipients.length === 0) {
      const reason = policies[0]?.reason ?? "policy_blocked";
      await updateEmailStatus(deps.gateway, table, inserted.id, null, reason);
      return { ok: true, id: inserted.id, email_skipped: reason };
    }

    const rendered = deps.renderNotificationHtml(request.surveyType, request.responseData, inserted.id);
    const subject = deps.notificationSubject(request.surveyType, now());
    const attempts = await Promise.all(allowedRecipients.map(({ recipient, index, policy }) => sendAndRecord(deps, {
      recipient, source: "submit-survey-response", templateSlug, policyDecisionId: policy.decisionId,
      policyReason: policy.reason, id: inserted.id, index, subject, html: rendered,
    })));
    const notAccepted = attempts.find((attempt) => !attempt.accepted);
    await updateEmailStatus(
      deps.gateway,
      table,
      inserted.id,
      notAccepted ? null : now().toISOString(),
      notAccepted?.error ?? notAccepted?.skip ?? null,
    );
    return { ok: true, id: inserted.id };
  };
}

function validRequest(request: ResearchSurveySubmitRequest): boolean {
  return (request.surveyType === "producer" || request.surveyType === "consumer")
    && Boolean(request.responseData && typeof request.responseData === "object" && !Array.isArray(request.responseData) && Object.keys(request.responseData).length > 0);
}

function readIp(headers: Headers | undefined): string | null {
  return headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || headers?.get("cf-connecting-ip") || null;
}

async function updateEmailStatus(
  gateway: ManagedSurveyResponseGateway,
  table: SurveyTable,
  id: string,
  sentAt: string | null,
  error: string | null,
): Promise<void> {
  try {
    await gateway.updateEmailStatus({ table, id, sentAt, error });
  } catch {
    // The survey row is durable; email metadata remains explicitly best effort.
  }
}

async function sendAndRecord(deps: ManagedSurveyResponseSubmitDeps, input: {
  recipient: string; source: string; templateSlug: string; policyDecisionId: string | null; policyReason: string;
  id: string; index: number; subject: string; html: string;
}): Promise<PublicIntakeDeliveryResult> {
  try {
    return await deps.delivery.deliver({
      source: input.source,
      templateSlug: input.templateSlug,
      policyDecisionId: input.policyDecisionId,
      dedupeKey: `${input.templateSlug}:${input.id}:${input.index}`,
      purpose: "admin_notification",
      triggerEvent: "survey_response_submitted",
      recipientEmail: input.recipient,
      aggregateType: "survey_response",
      aggregateId: input.id,
      metadata: { surveyResponseId: input.id, policyReason: input.policyReason },
      message: {
        sender: deps.fromEmail,
        to: input.recipient,
        subject: input.subject,
        html: input.html,
      },
    });
  } catch {
    return { accepted: false, messageId: null, skip: null, error: "email_ledger_unavailable" };
  }
}

