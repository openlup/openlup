import { checkoutOrchestrationFailureDetails as failureDetails } from "@openlup/platform/commerce/server";
export { safeCommerceDiagnosticValue } from "@openlup/platform/commerce/server";
export function checkoutOrchestrationFailureDetails(reason: string | null) {
  return failureDetails(reason, previewCheckoutDiagnosticsEnabled());
}
export function previewCheckoutDiagnosticsEnabled(): boolean {
  return process.env.HIDDEN_SANDBOX_PREVIEW_ENABLED === "true" || process.env.VERCEL_ENV === "preview";
}
