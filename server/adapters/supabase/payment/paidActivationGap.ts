import type { PaidSubscriptionActivationGapRow } from "../../../../src/domains/payment/contracts.js";
import type { PaidActivationGapPort } from "../../../domains/payment/paidActivationGapPort.js";

interface RpcError { message?: string; code?: string }

export interface PaidActivationGapClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
  from<T = Record<string, unknown>>(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): PromiseLike<{ data: T | null; error: RpcError | null }>;
      };
    };
  };
}

export function createSupabasePaidActivationGapPort(client: PaidActivationGapClient): PaidActivationGapPort {
  return {
    async reconcile(limit = 200): Promise<{ enqueued: number; overdue: number }> {
      const { data, error } = await client.rpc("subscription_reconcile_paid_activation_gaps", {
        p_limit: limit,
      });
      if (error) throw new Error(`subscription_reconcile_paid_activation_gaps: ${error.message ?? error.code ?? "failed"}`);
      const envelope = asRecord(data).paidActivationGapReconciliation;
      const result = asRecord(envelope);
      return { enqueued: number(result.enqueued), overdue: number(result.overdue) };
    },

    async isStillOpen(subscriptionId: string): Promise<boolean> {
      const { data, error } = await client
        .from<PaidSubscriptionActivationGapRow>("subscription_paid_activation_gaps")
        .select("subscription_id")
        .eq("subscription_id", subscriptionId)
        .maybeSingle();
      if (error) throw new Error(`subscription_paid_activation_gaps: ${error.message ?? error.code ?? "failed"}`);
      return Boolean(data);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
