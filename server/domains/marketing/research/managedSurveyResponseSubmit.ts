import type { ResearchSurveySubmitRequest, ResearchSurveySubmitResponse } from "../../../../src/domains/marketing/research/contracts.js";
import type { PublicIntakeDeliveryPort, PublicIntakeDeliveryResult } from "../../communications/ports.js";

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

    const rendered = renderSurveyEmail(request.surveyType, request.responseData, inserted.id);
    const subject = `[Interzoo Survey] New ${request.surveyType} response — ${now().toISOString().slice(0, 16).replace("T", " ")} UTC`;
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

function renderSurveyEmail(type: "producer" | "consumer", data: Record<string, unknown>, id: string): string {
  const label = type === "producer" ? "Producer (B2B)" : "Consumer (B2C)";
  const rows = Object.entries(data).map(([key, value]) => `<tr><td style="padding:8px 12px;font-size:13px;color:#666;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eee;">${esc(key)}</td><td style="padding:8px 12px;font-size:13px;color:#111;border-bottom:1px solid #eee;">${flattenValue(value)}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5;"><div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;border:1px solid #e0e0e0;"><h2 style="margin:0 0 4px 0;font-size:18px;color:#042B2C;">Interzoo 2026 — new ${esc(label)} response</h2><p style="margin:0 0 16px 0;font-size:12px;color:#888;">Response ID: ${esc(id)}</p><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:6px;border:1px solid #e0e0e0;">${rows}</table><details style="margin-top:16px;"><summary style="cursor:pointer;font-size:12px;color:#555;">Full JSON payload</summary><pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto;font-size:11px;color:#222;">${esc(JSON.stringify(data, null, 2))}</pre></details><p style="margin:24px 0 0 0;font-size:11px;color:#999;">Submitted via kiosk tablet · Interzoo 2026 · Hall 3, Booth 3-531E</p></div></body></html>`;
}

function flattenValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.map(esc).join(", ") : "—";
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, child]) => `${esc(key)}: ${esc(child)}`).join(" · ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return esc(value);
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
