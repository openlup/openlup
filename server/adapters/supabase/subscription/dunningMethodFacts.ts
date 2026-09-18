// The dunning copy's method facts: the scheme label and trailing digits of the
// method that was supposed to back this renewal.
//
// Named without a vendor on purpose, unlike the historical vendor-prefixed
// names of its siblings here. Nothing below is vendor-specific: the client is a
// structural `from(...)` query builder, so the same adapter serves any driver
// that exposes one — which is what §0.3 of the dunning program asks of new
// runtime surface.
//
// The facts live on `commerce_payment_method_refs.consent_snapshot` under the
// two keys the card rail's normalizer writes (#2477). They are DISPLAY data —
// never an authorization input — so every unhappy path answers null and the
// email simply drops one sentence. Nothing here can block a send.
//
// The read is deliberately narrow: the active ref for this subscription and two
// snapshot keys, nothing that could turn an email into a PAN-adjacent surface.

import type {
  DunningMethodFacts,
  DunningMethodFactsPort,
} from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";
import { methodFactsFromConsentSnapshot } from "../../../domains/subscription/subscriptionDunningDispatchPorts.js";

interface MethodFactsQueryBuilder {
  select(columns: string): MethodFactsQueryBuilder;
  eq(column: string, value: unknown): MethodFactsQueryBuilder;
  order(column: string, options: { ascending: boolean }): MethodFactsQueryBuilder;
  limit(count: number): MethodFactsQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface DunningMethodFactsQueryClient {
  from(table: string): MethodFactsQueryBuilder;
}

export function createDunningMethodFactsPort(
  client: DunningMethodFactsQueryClient,
): DunningMethodFactsPort {
  return {
    async resolve(subscriptionId: string): Promise<DunningMethodFacts | null> {
      if (!subscriptionId) return null;
      const { data, error } = await client
        .from("commerce_payment_method_refs")
        .select("consent_snapshot")
        .eq("subscription_id", subscriptionId)
        .eq("active", true)
        // A deactivated-then-re-registered method leaves more than one active
        // row only transiently; the freshest write is the one that describes
        // the method the failed charge actually used.
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data || typeof data !== "object") return null;
      return methodFactsFromConsentSnapshot((data as Record<string, unknown>).consent_snapshot);
    },
  };
}
