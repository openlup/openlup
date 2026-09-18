import {
  resolveOrderInvoiceAction,
  type ChannelInvoiceAction,
  type OrderInvoicePolicy,
} from "../../../src/domains/channels/ports.js";

// Wave B6: the sales-source gate on the accounting issue-REQUEST producers.
//
// Every producer in this repository ends at one of two port calls —
// `requestInvoiceIssueFromPaidOrder(orderId)` or
// `requestInvoiceIssueFromFulfillmentHandoff(fulfillmentOrderId)` — so the gate
// is stated once, in the two keys those calls actually carry, and each producer
// asks it before it requests. The gate does NOT decorate the port: the port's
// response describes a persisted invoice, and a decorator that suppressed a
// request would have to fabricate one. A decision the caller records in its own
// outcome is honest; a fabricated invoice id is not.
//
// NO NEW SCHEMA. `channel_issues` wants a `metadata.invoiceIssuedBy = 'channel'`
// stamp on the order, and there is no metadata write path from here: neither
// issue-request contract carries a metadata argument, no generic order-metadata
// merge RPC exists in this repository's RPC catalog, and the canonical-money
// freeze trigger guards the header. The decision is therefore recorded in the
// producer's own outbox/handler detail under the same key name, where the
// dispatcher persists it into `outbox_events.metadata` — visible to an operator,
// and costing this wave no migration.

export type InvoicePolicyLookup =
  | { by: "order"; orderUuid: string }
  | { by: "fulfillmentOrder"; fulfillmentOrderId: string };

/**
 * Reads the sales-source invoice policy for one order, by either key a producer
 * holds. `null` is the answer for an order that names no channel — a storefront
 * order, or one that predates the source axis.
 *
 * Read failures are NOT swallowed here. Every call site already sits inside a
 * try/catch whose policy is the right one for its path: the outbox handlers turn
 * it into a retry (retrying a policy read is exactly right), and the fail-soft
 * fulfillment wrappers treat it like any other accounting error.
 */
export interface OrderInvoicePolicyReader {
  readOrderInvoicePolicy(lookup: InvoicePolicyLookup): Promise<OrderInvoicePolicy | null>;
}

/**
 * A plain record rather than a discriminated union: this repository's node
 * project does not narrow on a boolean literal discriminant, and a caller that
 * has to cast to reach `detail` is worse than a `detail` that is empty when the
 * answer is `issue`.
 */
export interface ChannelInvoiceDecision {
  issue: boolean;
  action: ChannelInvoiceAction;
  detail: Record<string, unknown>;
}

const ISSUE: ChannelInvoiceDecision = { issue: true, action: "issue", detail: {} };

function refusal(action: ChannelInvoiceAction): ChannelInvoiceDecision {
  return {
    issue: false,
    action,
    detail: action === "channel_issues"
      // The far side mints the document. Stamped with the same key an order
      // metadata write would have used, so a later wave that gains a metadata
      // path moves the value rather than renaming it.
      ? { invoicePolicy: action, invoiceIssuedBy: "channel", accountingInvoiceSkipped: action }
      // The operator declared that no sales document is produced at all.
      : { invoicePolicy: action, accountingInvoiceSkipped: action },
  };
}

/**
 * Whether this deployment should request the sales document for an order.
 *
 * An ABSENT reader answers `issue`. Composition roots that predate this wave —
 * and every test that builds a producer without one — keep today's behaviour
 * exactly, which is what makes the storefront path provably unchanged.
 */
export async function decideChannelInvoice(
  reader: OrderInvoicePolicyReader | undefined,
  lookup: InvoicePolicyLookup,
): Promise<ChannelInvoiceDecision> {
  if (!reader) return ISSUE;
  const action = resolveOrderInvoiceAction(await reader.readOrderInvoicePolicy(lookup));
  return action === "issue" ? ISSUE : refusal(action);
}
