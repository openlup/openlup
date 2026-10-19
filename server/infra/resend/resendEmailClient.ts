import { resolveEgressMode } from "#communications-egress-policy";
import { postResendEmail as post, type ResendEmailSendInput } from "@openlup/platform/communications";
export { getResendEmail } from "@openlup/platform/communications";
export type { ResendEmailSendInput, ResendEmailSendOutcome, ResendEmailPostResult, ResendEmailReadResult } from "@openlup/platform/communications";
export async function postResendEmail(input: ResendEmailSendInput) {
  return post(input, resolveEgressMode, process.env);
}
