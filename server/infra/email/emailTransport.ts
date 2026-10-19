import { postResendEmail } from "../resend/resendEmailClient.js";
import type { EmailTransport } from "@openlup/platform/communications";
export { emailTransportMessageId, emailTransportLedgerIdentifier, failedEmailTransportResult, classifyEmailSendOutcome, withEmailSendSkipReason, createInMemoryEmailTransport } from "@openlup/platform/communications";
export type { EmailMessage, EmailSendOutcome, EmailSendResult, EmailSendSkipReason, EmailSendOutcomeLike, EmailSendOutcomeProjection, EmailTransport, InMemoryEmailTransport } from "@openlup/platform/communications";
export const DEFAULT_EMAIL_PROVIDER_KIND = "resend";

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
 * The concrete project names live in the deployment's secrets documentation,
 * deliberately not repeated here: this file is a publishable reference adapter
 * and a product name in it is counted vocabulary.
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
