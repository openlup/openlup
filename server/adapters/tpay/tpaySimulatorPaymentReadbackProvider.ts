import type {
  PaymentProviderReconciliationProvider,
  ProviderReconciliationStatus,
} from "../../domains/payment/paymentProviderReconciliationWorker.js";

interface SimulatorAttemptRow {
  status: string;
  amount_cents: number;
  currency: string;
  failure_reason: string | null;
  updated_at: string;
}

interface SimulatorAttemptQuery {
  select(columns: string): SimulatorAttemptQuery;
  eq(column: string, value: unknown): SimulatorAttemptQuery;
  maybeSingle(): PromiseLike<{
    data: SimulatorAttemptRow | null;
    error: { message?: string } | null;
  }>;
}

export interface TpaySimulatorPaymentReadbackClient {
  from(table: "commerce_payment_attempts"): SimulatorAttemptQuery;
}

/**
 * The staging Tpay simulator has no external PSP state: its authenticated
 * simulator webhook writes the authoritative terminal result to payment-control.
 * Read that durable attempt instead of the stateless simulator HTTP client,
 * whose generic getTransaction response is intentionally always pending.
 */
export function createTpaySimulatorPaymentReadbackProvider(
  client: TpaySimulatorPaymentReadbackClient,
): PaymentProviderReconciliationProvider {
  return {
    async readPayment({ providerPaymentId }): Promise<ProviderReconciliationStatus> {
      if (!providerPaymentId.startsWith("tpay_sim_")) {
        return unavailable("simulator_provider_id_invalid");
      }

      const { data, error } = await client
        .from("commerce_payment_attempts")
        .select("status, amount_cents, currency, failure_reason, updated_at")
        .eq("provider", "tpay")
        .eq("provider_attempt_id", providerPaymentId)
        .maybeSingle();
      if (error) throw new Error(`tpay_simulator_payment_readback: ${error.message ?? "query failed"}`);
      if (!data) return unavailable("simulator_payment_not_found");

      const status = normalizeStatus(data.status);
      return {
        status,
        providerStatus: data.status,
        occurredAt: validIsoDate(data.updated_at),
        failureReason: status === "failed"
          ? data.failure_reason ?? `tpay_simulator_${data.status}`
          : null,
        amountMinor: Number.isInteger(data.amount_cents) ? data.amount_cents : null,
        currency: /^[A-Za-z]{3}$/.test(data.currency) ? data.currency.toUpperCase() : null,
        rawPayload: {
          provider: "tpay-simulator",
          status: data.status,
          amountMinorPresent: Number.isInteger(data.amount_cents),
          currency: /^[A-Za-z]{3}$/.test(data.currency) ? data.currency.toUpperCase() : null,
        },
      };
    },
  };
}

function normalizeStatus(status: string): ProviderReconciliationStatus["status"] {
  if (status === "succeeded") return "succeeded";
  // Only statuses accepted by the authenticated simulator settlement route are
  // authoritative. `cancelled` can be an internal compensation/admin state and
  // must not be treated as PSP proof that money cannot still arrive.
  if (["failed", "expired"].includes(status)) return "failed";
  if (["created", "sent_to_provider", "requires_action", "processing"].includes(status)) {
    return "pending";
  }
  return "unknown";
}

function unavailable(providerStatus: string): ProviderReconciliationStatus {
  return {
    status: "unknown",
    providerStatus,
    occurredAt: null,
    failureReason: null,
    amountMinor: null,
    currency: null,
    rawPayload: { provider: "tpay-simulator", status: providerStatus },
  };
}

function validIsoDate(value: string): string | null {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
