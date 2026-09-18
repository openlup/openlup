import type { CustomerDiagnosticReporter } from "@/lib/flags";
import { BffClientError } from "@/lib/bff/client";

export type CheckoutDiagnosticCode = "observed" | "succeeded" | "rejected" | "unknown" | "timeout";
type CheckoutDiagnosticSource = BffClientError | undefined;

export function checkoutDiagnosticSource(error: unknown): CheckoutDiagnosticSource {
  return error instanceof BffClientError ? error : undefined;
}

export function startCheckoutDiagnostic(headers: HeadersInit | undefined, reporter: Promise<CustomerDiagnosticReporter | null>, clientActionKey: string): {
  settle: (code: Exclude<CheckoutDiagnosticCode, "observed">, source?: CheckoutDiagnosticSource) => void;
  failure: <T>(error: T, code: Exclude<CheckoutDiagnosticCode, "observed">, source?: CheckoutDiagnosticSource) => T;
} {
  try {
    const authorization = new Headers(headers).get("Authorization");
    const accessToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
    const report = (phase: "attempted" | "settled", code: CheckoutDiagnosticCode, source?: CheckoutDiagnosticSource): void => {
      const relatedRequestId = source?.requestId;
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "checkout_submit", phase, code, clientActionKey,
            ...(relatedRequestId ? { relatedRequestId } : {}),
          }, accessToken);
        } catch {
          // Browser diagnostics cannot affect a checkout outcome.
        }
      }).catch(() => undefined);
    };
    report("attempted", "observed");
    return {
      settle: (code, source) => report("settled", code, source),
      failure: (error, code, source = checkoutDiagnosticSource(error)) => (report("settled", code, source), error),
    };
  } catch {
    return { settle: () => {}, failure: (error) => error };
  }
}
