import { createResendTransport as createTransport, resolveEmailApiKey as resolveKey } from "@openlup/platform/communications";
import { postResendEmail } from "../resend/resendEmailClient.js";
export { DEFAULT_EMAIL_PROVIDER_KIND, emailTransportMessageId, emailTransportLedgerIdentifier, failedEmailTransportResult, classifyEmailSendOutcome, withEmailSendSkipReason, createInMemoryEmailTransport } from "@openlup/platform/communications";
export type { EmailMessage, EmailSendOutcome, EmailSendResult, EmailSendSkipReason, EmailSendOutcomeLike, EmailSendOutcomeProjection, EmailTransport, InMemoryEmailTransport } from "@openlup/platform/communications";
export function createResendTransport(opts: { apiKey: string; env?: Record<string, string | undefined> }) {
  return createTransport(opts, postResendEmail);
}
export const createEmailTransport = createResendTransport;
export function resolveEmailApiKey(env: Record<string, string | undefined> = process.env): string { return resolveKey(env); }
