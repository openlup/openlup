import { resolveEgressMode } from "#communications-egress-policy";
import { postResendEmail as post, getResendEmail as get, type ResendEmailSendInput } from "@openlup/platform/communications";
const provider = { endpoint: "https://api.resend.com/emails", httpErrorPrefix: "Resend HTTP" };
export function getResendEmail(input: Parameters<typeof get>[0]) { return get(input, provider); }
export type { ResendEmailSendInput, ResendEmailSendOutcome, ResendEmailPostResult, ResendEmailReadResult } from "@openlup/platform/communications";
export async function postResendEmail(input: ResendEmailSendInput) {
  return post(input, resolveEgressMode, provider, process.env);
}
