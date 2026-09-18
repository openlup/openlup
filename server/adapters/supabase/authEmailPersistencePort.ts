/**
 * Supabase persistence adapter for the inactive Auth Send Email candidate.
 *
 * Owns the managed notification-control lookup plus best-effort ledger and
 * delivery-timeline writes. The Auth domain sees only `AuthEmailPersistencePort`
 * and never receives this client or provider operation vocabulary.
 */
import type { AuthEmailPersistencePort } from "../../domains/auth/ports.js";
import { classifyEmailSendOutcome } from "../../infra/email/emailTransport.js";
import {
  createEmailNotificationControlPort,
} from "../../infra/email/emailNotificationControl.js";
import { logEmailLedgerInsertFailure } from "../resend/emailLedgerLog.js";
import {
  recordEmailDeliveryTimeline,
  type EmailDeliveryTimelineClient,
} from "../resend/emailDeliveryTimeline.js";

interface NotificationControlQuery {
  select(columns: string): NotificationControlQuery;
  eq(column: string, value: unknown): NotificationControlQuery;
  maybeSingle(): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface SupabaseAuthEmailPersistenceClient extends EmailDeliveryTimelineClient {
  from(table: string): NotificationControlQuery & {
    insert(row: Record<string, unknown>):
      | PromiseLike<{ error?: unknown }>
      | { error?: unknown }
      | { select(columns: string): { maybeSingle(): PromiseLike<{ data?: { id?: string } | null; error?: unknown }> } };
  };
}

export function createSupabaseAuthEmailPersistencePort(input: {
  createClient: () => SupabaseAuthEmailPersistenceClient;
  now?: () => Date;
}): AuthEmailPersistencePort {
  let client: SupabaseAuthEmailPersistenceClient | null = null;
  const getClient = (): SupabaseAuthEmailPersistenceClient => (client ??= input.createClient());

  return {
    isTemplateEnabled(templateSlug, signal) {
      return createEmailNotificationControlPort(getClient()).isEnabled(templateSlug, signal);
    },

    async recordSend(send): Promise<void> {
      const persistence = getClient();
      const outcome = {
        ok: send.outcome.ok,
        resendId: send.outcome.messageId,
        providerError: send.outcome.providerError,
        aborted: send.outcome.aborted,
        skipReason: send.outcome.skipReason,
      };
      const projection = classifyEmailSendOutcome(outcome);
      const recordTimeline = (emailSendId: string | null) => recordEmailDeliveryTimeline(persistence, {
        dedupeKey: send.dedupeKey,
        templateSlug: send.templateSlug,
        purpose: "transactional",
        triggerSource: "auth-send-email",
        triggerEvent: send.templateSlug.slice("auth-".length),
        status: projection.timelineStatus,
        recipientEmail: send.recipientEmail,
        authUserId: send.authUserId,
        aggregateType: "auth_user",
        aggregateId: send.aggregateId,
        emailSendId,
        providerKind: send.providerKind,
        providerMessageId: send.outcome.messageId,
        lastErrorCode: projection.lastErrorCode,
        metadata: projection.skipReason
          ? { ...send.metadata, skipped: projection.skipReason }
          : send.metadata,
      }, { context: "auth-send-email" });

      const prelinked = await recordTimeline(null);
      const providerResponse = {
        ...send.providerResponse,
        ...send.metadata,
        ...(prelinked ? { sendAttemptId: prelinked } : { sendAttemptLink: "timeline_unavailable" }),
      };
      try {
        const inserted = persistence.from("email_sends").insert({
          tester_id: null,
          template_slug: send.templateSlug,
          source: "auth-send-email",
          resend_id: send.outcome.messageId,
          status: projection.ledgerStatus,
          sent_at: projection.sentAtEligible ? (input.now?.() ?? new Date()).toISOString() : null,
          provider_error: send.outcome.providerError,
          provider_response: providerResponse,
        });
        const selected = supportsInsertSelect(inserted)
          ? await inserted.select("id").maybeSingle()
          : await inserted;
        const error = (selected as { error?: unknown } | undefined)?.error;
        if (error) logEmailLedgerInsertFailure({ source: "auth-send-email", templateSlug: send.templateSlug, error });
        const emailSendId = (selected as { data?: { id?: string } | undefined } | undefined)?.data?.id ?? null;
        if (prelinked && emailSendId) await recordTimeline(emailSendId);
        else if (!prelinked) await recordTimeline(emailSendId);
      } catch (error) {
        logEmailLedgerInsertFailure({ source: "auth-send-email", templateSlug: send.templateSlug, error });
      }
    },
  };
}

function supportsInsertSelect(value: unknown): value is {
  select(columns: string): { maybeSingle(): PromiseLike<{ data?: { id?: string } | null; error?: unknown }> };
} {
  return typeof value === "object" && value !== null && "select" in value && typeof value.select === "function";
}
