import type {
  DeliveryAlignmentRow,
  DeliveryAlignmentRowsReader,
} from "../domains/customers/customerSubscriptionDeliveryAlignmentReadModel.js";
import {
  parseDeliveryAlignmentAdmissionResponse,
  type DeliveryAlignmentAdmissionClient,
} from "../domains/subscription/callSubscriptionDeliveryAlignmentAdmission.js";
import type { DeliveryAlignmentCaseEvidenceRow } from "../domains/platform/subscriptionObservabilityEvidence.js";

type Result<T> = { data: T | null; error: { code?: string; message?: string } | null };
type Query<T> = PromiseLike<Result<T[]>> & {
  in(column: string, values: readonly string[]): Query<T>;
  limit(count: number): Query<T>;
  order(column: string, options: { ascending: boolean }): Query<T>;
};
type DatabaseClient = {
  from<T>(table: string): { select(columns: string): Query<T> };
  rpc(name: string, args: Record<string, unknown>): PromiseLike<Result<unknown>>;
};

export function createCustomerDeliveryAlignmentRowsReader(client: unknown): DeliveryAlignmentRowsReader {
  const databaseClient = client as DatabaseClient;
  return async (subscriptionIds) => {
    const { data, error } = await databaseClient.from<DeliveryAlignmentRow>("subscription_delivery_alignment_cases")
      .select("subscription_id, state, aligned_next_cycle_at, updated_at")
      .in("subscription_id", subscriptionIds).in("state", ["protected", "aligned"])
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  };
}

export function createDeliveryAlignmentAdmissionClient(client: unknown): DeliveryAlignmentAdmissionClient {
  const databaseClient = client as DatabaseClient;
  return {
    async admitDeliveryAlignment(input) {
      const { data, error } = await databaseClient.rpc("subscription_delivery_alignment_admit_renewal", {
        p_subscription_id: input.subscriptionId,
        p_scheduled_at: input.scheduledAt,
        p_as_of: input.asOf,
      });
      return parseDeliveryAlignmentAdmissionResponse(data, error);
    },
  };
}

export async function readOpenDeliveryAlignmentCases(client: unknown): Promise<DeliveryAlignmentCaseEvidenceRow[]> {
  const databaseClient = client as DatabaseClient;
  const { data, error } = await databaseClient.from<DeliveryAlignmentCaseEvidenceRow>("subscription_delivery_alignment_cases")
    .select("subscription_id,state,observed_next_cycle_at")
    .in("state", ["protected", "manual_review"]).limit(2000);
  if (error) throw error;
  return data ?? [];
}
