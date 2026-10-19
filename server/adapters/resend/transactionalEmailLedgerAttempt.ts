import type { TransactionalEmailSendOutcome } from "../../domains/commerce/outboxOrderDraftEmailPorts.js";
import { classifyEmailSendOutcome } from "../../infra/email/emailTransport.js";
import { withEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import { logEmailLedgerInsertFailure } from "./emailLedgerLog.js";

export interface TransactionalEmailLedgerClient {
  from(table: string): EmailSendsQueryBuilder;
}

interface EmailSendsQueryBuilder {
  select(columns: string): EmailSendsQueryBuilder;
  eq(column: string, value: unknown): EmailSendsQueryBuilder;
  neq(column: string, value: unknown): EmailSendsQueryBuilder;
  limit(count: number): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
  insert(row: Record<string, unknown>): EmailSendsInsertResult;
}

type EmailSendsInsertResult =
  | PromiseLike<{ error: unknown }>
  | {
    select(columns: string): {
      maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };

export async function logTransactionalEmailAttempt(input: {
  client: TransactionalEmailLedgerClient;
  source: string;
  templateSlug: string;
  outboxEventId: string;
  orderId: string | null;
  outcome: TransactionalEmailSendOutcome;
  providerResponse: Record<string, unknown>;
  sendAttemptId: string | null;
  originMetadata: Record<string, string>;
}): Promise<string | null> {
  const projected = classifyEmailSendOutcome(input.outcome);
  try {
    const insertResult = input.client.from("email_sends").insert({
      tester_id: null,
      template_slug: input.templateSlug,
      source: input.source,
      resend_id: input.outcome.resendId,
      status: projected.ledgerStatus,
      sent_at: projected.sentAtEligible ? new Date().toISOString() : null,
      provider_error: input.outcome.providerError,
      provider_response: withEmailOriginMetadata(input.providerResponse, input.originMetadata, {
        triggerSource: input.source,
        triggerReason: input.templateSlug,
        outboxEventId: input.outboxEventId,
        ...(input.sendAttemptId
          ? { sendAttemptId: input.sendAttemptId }
          : { sendAttemptLink: "timeline_unavailable" }),
        ...(input.orderId ? { orderId: input.orderId } : {}),
      }),
    });
    if (supportsInsertSelect(insertResult)) {
      const result = await insertResult.select("id").maybeSingle();
      if (result.error) {
        logEmailLedgerInsertFailure({ source: input.source, templateSlug: input.templateSlug, error: result.error });
        return null;
      }
      return readInsertedId(result.data);
    }
    const result = await insertResult;
    if (result.error) logEmailLedgerInsertFailure({ source: input.source, templateSlug: input.templateSlug, error: result.error });
    return null;
  } catch (err) {
    logEmailLedgerInsertFailure({ source: input.source, templateSlug: input.templateSlug, error: err });
    return null;
  }
}

function readInsertedId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id ? id : null;
}

function supportsInsertSelect(value: EmailSendsInsertResult): value is Extract<EmailSendsInsertResult, { select(columns: string): unknown }> {
  return typeof value === "object" && value !== null && "select" in value && typeof value.select === "function";
}
