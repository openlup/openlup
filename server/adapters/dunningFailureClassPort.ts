// The dunning copy's cause fact: the neutral failure class recorded on the case
// this notification belongs to.
//
// Lives under `server/adapters/**` rather than beside its sibling reads in
// `server/domains/subscription/`: those predate the adapter-boundary target
// architecture, and the domain-boundary ratchet counts every `from`/`rpc` under
// `server/domains` precisely so new concrete reads stop landing there. The port
// CONTRACT stays in the domain; only this implementation is here.
//
// Flat, and NOT under a vendor subdirectory, because the client is typed as a
// structural `from(...)` query builder rather than an SDK: the same adapter
// serves any driver that exposes one, so filing it under one vendor's name would
// claim a dependency this file does not have.
//
// WHY A READ AND NOT A RE-DERIVATION. The notification payload already carries
// `failureReason`, and classifying that string in the worker would need no query
// at all. It would also be a second classifier with strictly weaker evidence: a
// synchronous refusal asserting `mandateUnsupported` persists `mandate_dead` on the
// case, but its reason key is scheme-named and deliberately absent from the
// kernel's table, so the re-derived answer would be `indeterminate` while the
// database says `mandate_dead`. One question gets one answer, and the answer
// lives on the case.
//
// The value is DISPLAY data — never a retry input, never an authorization input
// — so every unhappy path answers null and the email simply drops one sentence.
// Nothing here can block a send.

import type { DunningFailureClassPort } from "../domains/subscription/subscriptionDunningDispatchPorts.js";

interface FailureClassQueryBuilder {
  select(columns: string): FailureClassQueryBuilder;
  eq(column: string, value: unknown): FailureClassQueryBuilder;
  maybeSingle(): PromiseLike<{ data: unknown; error: unknown }>;
}

export interface DunningFailureClassQueryClient {
  from(table: string): FailureClassQueryBuilder;
}

/** A class token long enough to be one and short enough to be one. */
const CLASS_MAX_LENGTH = 40;

export function failureClassFromRow(row: unknown): string | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const value = (row as Record<string, unknown>).failure_class;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Deliberately NOT validated against the taxonomy here. The CHECK constraint on
  // the column is the guard; a value this deployment has never heard of resolves
  // to the `unknown` cause downstream, which renders nothing — the same outcome
  // as rejecting it, reached without a second copy of the class list.
  return trimmed.length > 0 && trimmed.length <= CLASS_MAX_LENGTH ? trimmed : null;
}

/**
 * Everything a customer-facing surface may say about one dunning case, beyond
 * what the case row already told its caller: the class behind the refusal and the
 * money it left unpaid.
 *
 * It lives beside the class read rather than in the recovery port under
 * `server/domains` for the reason the domain-boundary ratchet exists — new
 * concrete reads belong in adapters, and the alternative measurably tripped that
 * gate. Two queries, both display-only, both fail-SOFT: an unreadable row answers
 * null and the surface drops a line. Nothing here may stand between a payer and
 * the form that repairs their method.
 */
export interface DunningCaseDisplayFacts {
  failureClass: string | null;
  amountMinor: number | null;
  currency: string | null;
}

export function createDunningCaseDisplayFactsPort(client: DunningFailureClassQueryClient): {
  read(caseId: string): Promise<DunningCaseDisplayFacts>;
} {
  const empty: DunningCaseDisplayFacts = { failureClass: null, amountMinor: null, currency: null };
  return {
    async read(caseId: string): Promise<DunningCaseDisplayFacts> {
      try {
        const caseRow = await client
          .from("subscription_dunning_cases")
          .select("failure_class, order_id")
          .eq("id", caseId)
          .maybeSingle();
        if (caseRow.error || !caseRow.data) return empty;
        const failureClass = failureClassFromRow(caseRow.data);
        const orderId = (caseRow.data as Record<string, unknown>).order_id;
        if (typeof orderId !== "string" || orderId.length === 0) {
          return { failureClass, amountMinor: null, currency: null };
        }
        const orderRow = await client
          .from("commerce_orders")
          .select("total_cents, currency")
          .eq("id", orderId)
          .maybeSingle();
        if (orderRow.error || !orderRow.data) return { failureClass, amountMinor: null, currency: null };
        const order = orderRow.data as Record<string, unknown>;
        return {
          failureClass,
          amountMinor: typeof order.total_cents === "number" ? order.total_cents : null,
          currency: typeof order.currency === "string" ? order.currency : null,
        };
      } catch {
        return empty;
      }
    },
  };
}

export function createDunningFailureClassPort(
  client: DunningFailureClassQueryClient,
): DunningFailureClassPort {
  return {
    async resolve(caseId: string, _signal: AbortSignal): Promise<string | null> {
      try {
        const result = await client
          .from("subscription_dunning_cases")
          .select("failure_class")
          .eq("id", caseId)
          .maybeSingle();
        if (result.error) return null;
        return failureClassFromRow(result.data);
      } catch {
        return null;
      }
    },
  };
}
