import {
  DORMANT_OUTBOX_EXACT_EVENT_TYPE_NAMES,
  DORMANT_OUTBOX_PREFIX_EVENT_TYPE_NAMES,
} from "../../../../src/lib/outboxDormantEventTypes.js";
import type { OmniPackInboundEventRow } from "../../../domains/platform/omnipackObservabilityEvidence.js";
import { selectRows, type SupabaseObservabilityClient, type SupabaseQuery } from "./observabilityEvidenceQueries.js";

const DORMANT_OUTBOX_EXACT_FILTER = `(${DORMANT_OUTBOX_EXACT_EVENT_TYPE_NAMES.join(",")})`;

export function excludeDormantOutboxEvents<T>(query: SupabaseQuery<T>): SupabaseQuery<T> {
  let filtered = query.not("event_type", "in", DORMANT_OUTBOX_EXACT_FILTER);
  for (const prefix of DORMANT_OUTBOX_PREFIX_EVENT_TYPE_NAMES) {
    filtered = filtered.not("event_type", "like", `${prefix}%`);
  }
  return filtered;
}

export function selectRecentOmniPackQuarantine(
  client: SupabaseObservabilityClient,
  since: string,
): Promise<OmniPackInboundEventRow[]> {
  return selectRows<OmniPackInboundEventRow>(
    client.from<OmniPackInboundEventRow>("inbound_provider_events")
      .select("provider,processing_status,received_at,error")
      .eq("provider", "omnipack")
      .eq("processing_status", "ignored")
      .gte("received_at", since)
      .limit(2000),
    "inbound_provider_events_omnipack_quarantine",
  );
}

/**
 * Customer-facing payment notices whose handlers can settle an event WITHOUT
 * sending it. A four-entry list rather than a pattern on purpose: widening it
 * widens an alert, so it should be a decision someone makes deliberately.
 */
// Literals, deliberately, not imports of the matching constants in
// `src/domains/commerce/outboxEventContracts`. Importing them adds a dependency
// edge from this adapter into the commerce contracts, which transitively drags
// the currency module into `api/ops/platform-watchdog` — an entrypoint that then
// has to initialise the ambient settlement profile it has no other reason to
// touch (`tests/golden-master/ambientSettlementProfileNode.test.ts` proves it).
// A duplicated string is the cheaper coupling here.
export const SKIPPABLE_CUSTOMER_NOTICE_EVENT_TYPES = [
  "commerce.payment.failed",
  "commerce.checkout_recovery",
  "commerce.checkout.expired",
  "commerce.order_draft.created",
] as const;
