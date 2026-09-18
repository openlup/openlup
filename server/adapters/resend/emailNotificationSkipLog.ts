import { withEmailOriginMetadata } from "../../infra/resend/emailOriginMetadata.js";
import { EMAIL_NOTIFICATION_ADMIN_DISABLED } from "../../infra/email/emailNotificationControl.js";
import { logEmailLedgerInsertFailure } from "./emailLedgerLog.js";

export interface EmailNotificationSkipLogClient {
  from(table: string): {
    insert(row: Record<string, unknown>):
      | PromiseLike<{ error: unknown }>
      | { error: unknown }
      | { select(columns: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown }> } };
  };
}

export async function logAdminDisabledEmailSend(input: {
  client: EmailNotificationSkipLogClient;
  source: string;
  templateSlug: string;
  originMetadata: Record<string, string>;
  providerContext: Record<string, unknown>;
}): Promise<void> {
  try {
    const result = await input.client.from("email_sends").insert({
      tester_id: null,
      template_slug: input.templateSlug,
      source: input.source,
      resend_id: null,
      status: "skipped",
      sent_at: null,
      provider_error: null,
      provider_response: withEmailOriginMetadata(
        { skipped: EMAIL_NOTIFICATION_ADMIN_DISABLED },
        input.originMetadata,
        input.providerContext,
      ),
    });
    const awaited = await result;
    if ("error" in awaited && awaited.error) {
      logEmailLedgerInsertFailure({ source: input.source, templateSlug: input.templateSlug, error: awaited.error });
    }
  } catch (error) {
    logEmailLedgerInsertFailure({ source: input.source, templateSlug: input.templateSlug, error });
  }
}
