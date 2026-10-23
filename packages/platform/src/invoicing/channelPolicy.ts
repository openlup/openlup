type ChannelInvoiceAction = "issue" | "channel_issues" | "suppress";

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
  readOrderInvoicePolicy(lookup: InvoicePolicyLookup): Promise<ChannelInvoiceAction>;
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
  const action = await reader.readOrderInvoicePolicy(lookup);
  return action === "issue" ? ISSUE : refusal(action);
}
