import type {
  OrderBuyerCommsPolicy,
  OrderInvoicePolicy,
} from "../../../src/domains/channels/ports.js";
import type { OrderBuyerCommsPolicyReader } from "../../domains/commerce/outboxDispatchRegistry.js";
import type {
  InvoicePolicyLookup,
  OrderInvoicePolicyReader,
} from "../../domains/accounting/channelInvoicePolicyGate.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

// Direct-Postgres siblings of the managed policy readers. Same two questions,
// stated as SQL against the public platform chain, which authors both
// `sales_channels` (20260812150000) and the `commerce_orders` source axis
// (20260812160000) — so unlike the ingest store, this adapter is real for
// everything it exposes and has no missing capability to declare.
//
// The fulfillment-order lookup is the one departure: that chain has no
// `commerce_fulfillment_orders`, so that key is answered by name rather than by
// a fabricated null, which would read as "storefront order, issue the document"
// and quietly mint a duplicate for a marketplace that issues its own.

export class OrderInvoicePolicyLookupUnavailableError extends Error {
  readonly lookup: string;

  constructor(lookup: string) {
    super(
      `order_invoice_policy_lookup_unavailable: ${lookup} has no relation in the platform ` +
        "migration catalogue (no fulfillment order rail exists there)",
    );
    this.name = "OrderInvoicePolicyLookupUnavailableError";
    this.lookup = lookup;
  }
}

const ORDER_POLICY_SQL = `
  SELECT o.source_kind, c.buyer_comms_owner, c.invoice_policy
    FROM public.commerce_orders o
    LEFT JOIN public.sales_channels c ON c.id = o.source_channel_id
   WHERE o.id = $1::uuid`;

interface OrderPolicyRow {
  source_kind: string | null;
  buyer_comms_owner: string | null;
  invoice_policy: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function readPolicyRow(
  executor: PgQueryExecutor,
  orderUuid: string,
): Promise<OrderPolicyRow | null> {
  const result = await executor.query(ORDER_POLICY_SQL, [orderUuid]);
  return (result.rows[0] as unknown as OrderPolicyRow | undefined) ?? null;
}

export function createPostgresOrderBuyerCommsPolicyReader(
  executor: PgQueryExecutor,
): OrderBuyerCommsPolicyReader {
  return {
    async readOrderBuyerCommsPolicy(orderUuid: string): Promise<OrderBuyerCommsPolicy | null> {
      const row = await readPolicyRow(executor, orderUuid);
      const owner = text(row?.buyer_comms_owner);
      if (owner === null) return null;
      return { sourceKind: text(row?.source_kind) ?? "storefront", buyerCommsOwner: owner };
    },
  };
}

export function createPostgresOrderInvoicePolicyReader(
  executor: PgQueryExecutor,
): OrderInvoicePolicyReader {
  return {
    async readOrderInvoicePolicy(lookup: InvoicePolicyLookup): Promise<OrderInvoicePolicy | null> {
      if (lookup.by !== "order") {
        throw new OrderInvoicePolicyLookupUnavailableError("commerce_fulfillment_orders");
      }
      const row = await readPolicyRow(executor, lookup.orderUuid);
      const policy = text(row?.invoice_policy);
      if (policy === null) return null;
      return { sourceKind: text(row?.source_kind) ?? "storefront", invoicePolicy: policy };
    },
  };
}
