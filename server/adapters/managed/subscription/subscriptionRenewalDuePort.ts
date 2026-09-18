import type {
  DueSubscription,
  SubscriptionRenewalPersistencePort,
} from "../../../domains/subscription/chargeSubscriptionCycleOffSession.js";
import {
  buildSubscriptionCycleSnapshots,
  type SubscriptionCycleSnapshotClient,
} from "./buildSubscriptionCycleSnapshots.js";
import {
  callSubscriptionCreateCycleOrder,
  type CycleOrderRpcSupabaseClient,
} from "./callSubscriptionCreateCycleOrder.js";
import {
  callSubscriptionCycleReservationPreflight,
  type ReservationPreflightSupabaseClient,
} from "./callSubscriptionCycleReservationPreflight.js";

export interface DueSubscriptionRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

interface MandateModelQuery {
  eq(column: string, value: unknown): MandateModelQuery;
  limit(count: number): MandateModelQuery;
  maybeSingle(): PromiseLike<{ data: { consent_snapshot?: unknown } | null; error: unknown }>;
}

interface MandateModelClient {
  from(table: string): { select(columns: string): MandateModelQuery };
}

export type ManagedSubscriptionRenewalPersistenceClient = DueSubscriptionRpcClient
  & SubscriptionCycleSnapshotClient
  & CycleOrderRpcSupabaseClient
  & ReservationPreflightSupabaseClient
  & MandateModelClient;

interface DueSubscriptionRow {
  subscription_id: string;
  client_id: string;
  next_cycle_at: string;
  currency: string;
  provider_kind: string | null;
  provider_customer_ref: string | null;
  provider_method_ref: string | null;
  method_kind: string;
  payer_email: string | null;
  payer_name: string | null;
  method_status?: string | null;
  method_active?: boolean | null;
  method_expires_at?: string | null;
  method_client_id?: string | null;
}

export function createManagedSubscriptionRenewalDuePort(client: DueSubscriptionRpcClient) {
  return {
    async listDue(limit: number, asOf?: Date): Promise<DueSubscription[]> {
      const args = asOf
        ? { p_limit: limit, p_as_of: asOf.toISOString() }
        : { p_limit: limit };
      const { data, error } = await client.rpc("subscription_list_due_for_renewal", args);
      if (error) {
        throw new Error(`rpc_list_due: ${error.message ?? error.code ?? "unknown"}`);
      }
      const rows = Array.isArray(data) ? (data as DueSubscriptionRow[]) : [];
      return rows.map(toDueSubscription);
    },
  };
}

/** Concrete persistence behind the legacy hosted renewal use case. */
export function createManagedSubscriptionRenewalPersistencePort(
  client: ManagedSubscriptionRenewalPersistenceClient,
): SubscriptionRenewalPersistencePort {
  return {
    buildCycleSnapshots: (input) => buildSubscriptionCycleSnapshots(client, input),
    createCycleOrder: (input) => callSubscriptionCreateCycleOrder(client, input),
    preflightReservation: (input) => callSubscriptionCycleReservationPreflight(client, input),
    readMandateRecurringModel: (providerKind, providerMethodRef) =>
      readMandateRecurringModel(client, providerKind, providerMethodRef),
    async noteRowOutcome(input) {
      try {
        const { error } = await client.rpc("subscription_renewal_note_row_outcome", {
          p_subscription_id: input.subscriptionId,
          p_scheduled_at: input.scheduledAt,
          p_error_key: input.errorKey,
        });
        if (error) {
          console.warn("[cron/subscription-renewal] quarantine bookkeeping rejected", {
            subscription_id: input.subscriptionId,
            reason: error.message,
          });
        }
      } catch (error) {
        console.warn("[cron/subscription-renewal] quarantine bookkeeping threw", {
          subscription_id: input.subscriptionId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

async function readMandateRecurringModel(
  client: MandateModelClient,
  providerKind: string,
  providerMethodRef: string | null,
): Promise<"O" | "M" | undefined> {
  if (!providerMethodRef) return undefined;
  const { data, error } = await client.from("commerce_payment_method_refs")
    .select("consent_snapshot")
    .eq("provider_kind", providerKind)
    .eq("provider_method_ref", providerMethodRef)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("tpay_mandate_model_read_failed");
  const snapshot = data?.consent_snapshot;
  if (!snapshot || typeof snapshot !== "object") return undefined;
  const model = (snapshot as Record<string, unknown>).recurringModel;
  return model === "O" || model === "M" ? model : undefined;
}

function toDueSubscription(row: DueSubscriptionRow): DueSubscription {
  return {
    subscriptionId: row.subscription_id,
    clientId: row.client_id,
    nextCycleAt: row.next_cycle_at,
    currency: row.currency,
    providerKind: row.provider_kind ?? "",
    providerCustomerRef: row.provider_customer_ref,
    providerMethodRef: row.provider_method_ref,
    methodKind: row.method_kind ?? "",
    payerEmail: row.payer_email,
    payerName: row.payer_name,
    methodStatus: row.method_status ?? null,
    methodActive: typeof row.method_active === "boolean" ? row.method_active : null,
    methodExpiresAt: row.method_expires_at ?? null,
    methodClientId: row.method_client_id ?? null,
  };
}
