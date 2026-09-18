import { readCustomerJourneyAuthContext } from "./customerJourneyAuthContext";
import type { CustomerDiagnosticReporter } from "@/lib/flags";

export function reportCustomerJourneyPayment(
  action: "payment_confirm" | "payment_status",
  code: "succeeded" | "failed" | "unknown" | "retryable" | "timeout",
  reporter: Promise<CustomerDiagnosticReporter | null>,
  clientActionKey: string,
): void {
  try {
    const observation = { action, phase: "settled" as const, code, clientActionKey };
    const accessToken = readCustomerJourneyAuthContext();
    void reporter.then((loadedReporter) => {
      try {
        loadedReporter?.reportCustomerJourneyDiagnostic(observation, accessToken);
      } catch {
        // Browser diagnostics cannot affect a payment outcome.
      }
    }).catch(() => undefined);
  } catch {
    // Browser diagnostics cannot affect a payment outcome.
  }
}
