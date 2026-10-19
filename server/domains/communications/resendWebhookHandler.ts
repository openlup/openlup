export { RESEND_EVENT_MAP, readEmailEnvironmentTag, resolveResendEventTime } from "@openlup/platform/communications";
export type { EmailEnvironmentTag, ResendWebhookAttemptOutcome, ResendWebhookAttempt, ResendWebhookProviderEvent, ResendWebhookPort, ResendWebhookRequest, ResendWebhookResponse, ResendWebhookSignatureInput } from "@openlup/platform/communications";
import { createResendWebhookHandler as createHandler, type ResendWebhookHandlerDeps as HandlerDeps } from "@openlup/platform/communications";
export type ResendWebhookHandlerDeps = Omit<HandlerDeps, "eventSource">;
export function createResendWebhookHandler(deps: ResendWebhookHandlerDeps) {
  return createHandler({ ...deps, eventSource: "resend-webhook" });
}
