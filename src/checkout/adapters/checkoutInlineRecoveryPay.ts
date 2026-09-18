import { buildTpayCheckoutRequestPatch, type TpayCheckoutDraft } from "@/checkout/adapters/tpayCheckoutDraft";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import {
  checkoutInlineRecoveryPayRequestSchema,
  type CheckoutInlineRecoveryPayRequest,
} from "@/domains/commerce/checkoutInlineRecoveryContracts";
import type { PaymentStatusContinuationRequest } from "@/domains/commerce/paymentContinuationContracts";
import type { CheckoutPaymentRecoveryGuidance } from "@/domains/commerce/paymentRecoveryGuidanceContracts";
import { payCheckoutInlineRecovery } from "@/domains/commerce/checkoutRecoveryClient";
import { BffClientError } from "@/lib/bff/client";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";

/** Build only the two first-wave exact-order execution shapes. */
export function buildCheckoutInlineRecoveryPayRequest(input: {
  identity: PaymentStatusContinuationRequest;
  guidance: CheckoutPaymentRecoveryGuidance;
  data: ConfiguratorFormData;
  executionDraft: TpayCheckoutDraft;
  retryRequestId: string;
}): CheckoutInlineRecoveryPayRequest | null {
  const purchaseContext = input.data.subscription ? "subscription_initial" : "one_time";
  if (input.guidance.purchaseContext !== purchaseContext) return null;
  const common = {
    ...input.identity,
    expectedPaymentAttemptId: input.guidance.paymentAttemptId,
    retryRequestId: input.retryRequestId,
  };
  if (input.data.paymentMethod === "card") {
    const parsed = checkoutInlineRecoveryPayRequestSchema.safeParse({
      ...common, paymentMethod: "card", paymentProvider: "stripe",
    });
    return parsed.success ? parsed.data : null;
  }
  if (input.data.paymentMethod !== "blik") return null;
  const patch = buildTpayCheckoutRequestPatch({
    enabled: true,
    paymentMethod: "blik",
    draft: input.executionDraft,
    checkoutMode: input.data.subscription ? "subscription" : "one_time",
  });
  if (!patch?.paymentExecution || patch.paymentProvider !== "tpay") return null;
  const parsed = checkoutInlineRecoveryPayRequestSchema.safeParse({
    ...common,
    paymentMethod: "blik",
    paymentProvider: "tpay",
    paymentExecution: patch.paymentExecution,
  });
  return parsed.success ? parsed.data : null;
}

export function createCheckoutInlineRetryRequestId(): string {
  return crypto.randomUUID();
}

export async function executeCheckoutInlineRecovery(input: {
  identity: PaymentStatusContinuationRequest;
  guidance: CheckoutPaymentRecoveryGuidance;
  data: ConfiguratorFormData;
  executionDraft: TpayCheckoutDraft;
  retryRequestId: string;
  timeoutMs: number;
  onAuthorityChanged: () => void | Promise<void>;
}) {
  const diagnostic = startInlineRecoveryDiagnostic();
  let diagnosticSettled = false;
  try {
    const request = buildCheckoutInlineRecoveryPayRequest(input);
    if (!request) {
      diagnostic?.settle("validation_blocked");
      diagnosticSettled = true;
      throw new Error("checkout:errors.detailsIncomplete");
    }
    const result = await payCheckoutInlineRecovery(request, { timeoutMs: input.timeoutMs });
    diagnostic?.settle(result.status === "failed" ? "rejected" : "succeeded");
    diagnosticSettled = true;
    return { request, result };
  } catch (error) {
    if (!diagnosticSettled) diagnostic?.settle(recoveryDiagnosticCode(error), error);
    if (error instanceof BffClientError && (error.status === 401 || error.status === 409)) {
      await input.onAuthorityChanged();
    }
    throw error;
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof BffClientError) || error.code !== "UPSTREAM_UNAVAILABLE") return false;
  return typeof error.details === "object" && error.details !== null
    && "reason" in error.details && error.details.reason === "timeout";
}

type RecoveryDiagnosticCode = "succeeded" | "rejected" | "validation_blocked" | "unknown" | "timeout" | "transport_uncertain";

function startInlineRecoveryDiagnostic(): { settle: (code: RecoveryDiagnosticCode, error?: unknown) => void } | null {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return null;
    const report = (phase: "attempted" | "settled", code: "observed" | RecoveryDiagnosticCode, error?: unknown): void => {
      const relatedRequestId = error instanceof BffClientError ? error.requestId : undefined;
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "checkout_recovery_submit", phase, code, clientActionKey,
            ...(relatedRequestId ? { relatedRequestId } : {}),
          });
        } catch {
          // Diagnostics never change recovery payment behavior.
        }
      }).catch(() => {});
    };
    report("attempted", "observed");
    return { settle: (code, error) => report("settled", code, error) };
  } catch {
    return null;
  }
}

function recoveryDiagnosticCode(error: unknown): RecoveryDiagnosticCode {
  if (isTimeout(error)) return "timeout";
  if (error instanceof BffClientError) {
    if (error.status === 0) return "transport_uncertain";
    if (error.status >= 400 && error.status < 500) return "rejected";
    return "unknown";
  }
  return error instanceof TypeError ? "transport_uncertain" : "unknown";
}
