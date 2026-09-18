import type {
  CheckoutEmailOutboxReconcilePort,
  CheckoutEmailOutboxReconcileResult,
} from "../../../domains/commerce/outboxDispatchContracts.js";

type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
};

export function createSupabaseCheckoutEmailOutboxReconcilePort(
  client: RpcClient,
): CheckoutEmailOutboxReconcilePort {
  return {
    async reconcile(limit: number): Promise<CheckoutEmailOutboxReconcileResult> {
      const { data, error } = await client.rpc("commerce_reconcile_checkout_email_outbox", {
        p_limit: limit,
      });
      if (error) {
        throw new Error(`commerce_reconcile_checkout_email_outbox_failed: ${error.message ?? error.code ?? "unknown"}`);
      }
      return readResult(data);
    },
  };
}

function readResult(data: unknown): CheckoutEmailOutboxReconcileResult {
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
  const checked = objectField(record.checked);
  const inserted = objectField(record.inserted);
  return {
    checked: {
      paid: numberField(checked, "paid"),
      failed: numberField(checked, "failed"),
      expired: numberField(checked, "expired"),
    },
    inserted: {
      commerceOrderPaid: numberField(inserted, "commerceOrderPaid"),
      commerceOrderPaidEmail: numberField(inserted, "commerceOrderPaidEmail"),
      commercePaymentFailed: numberField(inserted, "commercePaymentFailed"),
      commerceCheckoutExpired: numberField(inserted, "commerceCheckoutExpired"),
    },
  };
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
