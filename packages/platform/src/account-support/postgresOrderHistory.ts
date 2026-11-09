import { deriveOrderMoney } from "../commerce/index.js";
import { toOrderMoneyHeader } from "./orderHistory.js";
import type { CustomerOrderHistoryReadStore, CustomerOrderHistoryRow } from "./orderHistory.js";
import type { OperatorQueryExecutor } from "./postgresOperatorAuthority.js";
import { accountRows, grouped, minor, record, text, readOwnedPaidActivationGaps, type NativeAccountReadScope, type NativePaidActivationGapReadSource } from "./postgresAccountReadScope.js";

export interface NativeOrderHistoryOptions extends NativeAccountReadScope {
  /** The selected invoice owner supplies its complete summary; no empty success fallback. */
  readInvoiceSummaries: CustomerOrderHistoryReadStore["readInvoiceSummaries"];
}

/** Native table shapes translated to the existing customer order projection contract. */
export function createPostgresCustomerOrderHistoryReadStore(
  executor: OperatorQueryExecutor, options: NativeOrderHistoryOptions,
): CustomerOrderHistoryReadStore & NativePaidActivationGapReadSource {
  const rows = accountRows(executor, options), clientId = options.clientId;
  const { readInvoiceSummaries } = options;
  const orderHeaders = async (predicate: string, values: unknown[], detail = false) => (await rows(`
    SELECT o.*, cycle.subscription_id FROM owned_orders o
    LEFT JOIN public.subscription_cycles cycle ON cycle.id=o.subscription_cycle_id ${predicate}`, values))
    .map(row => header(row, detail));
  const ownedIds = async (ids: string[]) => (await rows("SELECT id FROM owned_orders WHERE id=ANY($3::uuid[])", [ids])).map(row => text(row.id));
  return {
    readPaidActivationGaps(ids) { return readOwnedPaidActivationGaps(rows, ids); },
    async readCustomerOrders(owner, hiddenStatuses, limit) {
      if (owner !== clientId) return [];
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("native_account_order_limit_invalid");
      return orderHeaders("WHERE NOT(o.status=ANY($3::text[])) ORDER BY o.created_at DESC,o.id DESC LIMIT $4", [[...hiddenStatuses], limit]);
    },
    async readCustomerOrder(owner, orderId) {
      if (owner !== clientId) return null;
      return (await orderHeaders("WHERE o.id=$3::uuid", [orderId], true))[0] ?? null;
    },
    async readOrderLines(orderId) {
      const result = await rows(`SELECT item.*,o.metadata,o.currency_code,o.total_amount_minor FROM public.commerce_order_items item
        JOIN owned_orders o ON o.id=item.order_id
        WHERE o.id=$3::uuid ORDER BY item.line_ordinal,item.id`, [orderId]);
      // The existing projector owns aggregate reconciliation and its diagnostic-only
      // read fallback. Derived per-line VAT rounding is not a snapshot refusal.
      return result.map(line);
    },
    async readPaymentStatuses(orderIds) {
      const result = await rows(`SELECT DISTINCT ON(intent.order_id) intent.order_id,intent.status
        FROM public.commerce_settlement_intents intent JOIN owned_orders o ON o.id=intent.order_id
        WHERE o.id=ANY($3::uuid[]) ORDER BY intent.order_id,intent.updated_at DESC,intent.id DESC`, [orderIds]);
      return new Map(result.map(row => [text(row.order_id), row.status === "settled" ? "succeeded" : row.status === "failed" ? "failed" : row.status === "cancelled" ? "cancelled" : "pending"]));
    },
    async readFulfillments(owner, orderIds) {
      if (owner !== clientId) return [];
      return rows(`SELECT shipment.id,shipment.order_id,shipment.sequence_no,shipment.status,
        shipment.provider_type AS provider_kind,shipment.updated_at FROM public.fulfillment_shipments shipment
        JOIN owned_orders o ON o.id=shipment.order_id WHERE o.id=ANY($3::uuid[]) ORDER BY shipment.sequence_no,shipment.id`, [orderIds]);
    },
    async readTracking(orderIds) {
      const [observations, references] = await Promise.all([
        rows(`SELECT DISTINCT ON(shipment.id) shipment.order_id,shipment.id AS fulfillment_order_id,
          shipment.provider_type AS provider_kind,observation.observation,observation.first_received_at AS updated_at
          FROM public.fulfillment_observations observation JOIN public.fulfillment_shipments shipment ON shipment.id=observation.shipment_id
          JOIN owned_orders o ON o.id=shipment.order_id WHERE o.id=ANY($3::uuid[]) AND observation.status_recorded
            AND jsonb_array_length(COALESCE(observation.observation->'trackingRefs','[]'::jsonb))>0
          ORDER BY shipment.id,observation.first_received_at DESC,observation.event_key DESC`, [orderIds]),
        rows(`SELECT DISTINCT ON(ref.shipment_id,ref.ref_role) shipment.order_id,
          shipment.id AS fulfillment_order_id,shipment.provider_type AS provider_kind,ref.external_id AS provider_tracking_id,
          ref.recorded_at AS updated_at,NULL::text AS tracking_url,NULL::text AS carrier_kind,NULL::text AS service
          FROM public.shipment_external_refs ref JOIN public.fulfillment_shipments shipment ON shipment.id=ref.shipment_id
          JOIN owned_orders o ON o.id=shipment.order_id WHERE o.id=ANY($3::uuid[]) AND ref.ref_role='tracking'
          ORDER BY ref.shipment_id,ref.ref_role,ref.recorded_at DESC,ref.id DESC`, [orderIds]),
      ]);
      const captured = observations.flatMap(row => {
        const refs = record(row.observation).trackingRefs;
        return (Array.isArray(refs) ? refs : []).map(value => {
          const ref = record(value);
          return { order_id: row.order_id, fulfillment_order_id: row.fulfillment_order_id, provider_kind: row.provider_kind,
            provider_tracking_id: ref.trackingNumber, tracking_url: ref.publicUrl, carrier_kind: ref.carrierRef,
            service: ref.serviceRef, updated_at: row.updated_at };
        });
      });
      const observedParcels = new Set(captured.map(row => row.fulfillment_order_id));
      return grouped([...captured, ...references.filter(row => !observedParcels.has(row.fulfillment_order_id))], "order_id");
    },
    async readFulfillmentOperations(orderIds) {
      return grouped(await rows(`SELECT operation.order_id,operation.operation_type,operation.occurred_at
        FROM public.fulfillment_shipment_operations operation JOIN owned_orders o ON o.id=operation.order_id
        WHERE o.id=ANY($3::uuid[]) ORDER BY operation.occurred_at DESC,operation.id DESC`, [orderIds]), "order_id");
    },
    async readStatusEvidence(orderIds) {
      return grouped(await rows(`SELECT observation.event_key AS id,shipment.order_id,shipment.id AS fulfillment_order_id,
        observation.observation#>>'{fact,canonicalStatus}' AS local_status,observation.observation#>>'{providerStatus,primary}' AS provider_status,
        observation.observation#>>'{fact,occurredAt}' AS occurred_at,observation.first_received_at AS created_at
        FROM public.fulfillment_observations observation JOIN public.fulfillment_shipments shipment ON shipment.id=observation.shipment_id
        JOIN owned_orders o ON o.id=shipment.order_id WHERE o.id=ANY($3::uuid[]) AND observation.status_recorded
        ORDER BY observation.first_received_at DESC,observation.event_key DESC LIMIT 200`, [orderIds]), "order_id");
    },
    async readReleasedProviderExceptionHolds(orderIds) {
      const result = await rows(`SELECT hold.order_id,hold.status,hold.reason,hold.created_by,hold.released_by,hold.metadata
        FROM public.commerce_order_holds hold JOIN owned_orders o ON o.id=hold.order_id
        WHERE o.id=ANY($3::uuid[]) AND hold.status='released' AND hold.reason='fulfillment_exception'`, [orderIds]);
      return new Map([...grouped(result, "order_id")].map(([id, holds]) => [id, holds.map(hold => ({
        orderId: text(hold.order_id), status: text(hold.status), reason: text(hold.reason),
        createdBy: hold.created_by as string | null, releasedBy: hold.released_by as string | null, metadata: hold.metadata,
      }))]));
    },
    async readReleasedProviderExceptionEvidence(holds) {
      // Native holds have no managed provider-exception evidence-ID relation.
      // The native observation ledger is read for those owned orders, without inventing a cleared exception.
      return grouped(await rows(`SELECT observation.event_key AS id,shipment.order_id,shipment.id AS fulfillment_order_id,
        observation.observation#>>'{fact,canonicalStatus}' AS local_status,observation.observation#>>'{providerStatus,primary}' AS provider_status,
        observation.observation#>>'{fact,occurredAt}' AS occurred_at
        FROM public.fulfillment_observations observation JOIN public.fulfillment_shipments shipment ON shipment.id=observation.shipment_id
        JOIN owned_orders o ON o.id=shipment.order_id WHERE o.id=ANY($3::uuid[]) AND observation.status_recorded
        ORDER BY observation.first_received_at DESC,observation.event_key DESC`, [[...holds.keys()]]), "order_id");
    },
    async readActiveHoldOrderIds(orderIds) {
      return new Set((await rows(`SELECT DISTINCT hold.order_id FROM public.commerce_order_holds hold
        JOIN owned_orders o ON o.id=hold.order_id WHERE o.id=ANY($3::uuid[]) AND hold.status='active'`, [orderIds])).map(row => text(row.order_id)));
    },
    async readInvoiceSummaries(orderIds) {
      const ids = await ownedIds(orderIds);
      if (!ids.length) return new Map();
      return new Map([...await readInvoiceSummaries(ids)].filter(([id]) => ids.includes(id)));
    },
  };
}

function header(row: CustomerOrderHistoryRow, detail: boolean): CustomerOrderHistoryRow {
  if (!detail) return { ...row, currency: text(row.currency_code), total_cents: minor(row.total_amount_minor), native_money_summary: true };
  const quote = record(record(record(row.metadata).quoteSnapshot).quote);
  const currency = text(row.currency_code);
  const money = (name: string, optional = false) => {
    if (optional && quote[name] === undefined) return 0;
    const value = record(quote[name]);
    if (value.currency !== currency) throw new Error("native_account_order_money_unavailable");
    return minor(value.amountMinor);
  };
  const total = money("totalGross");
  if (total !== minor(row.total_amount_minor)) throw new Error("native_account_order_money_mismatch");
  const translated = { ...row, currency, total_cents: total, subtotal_cents: money("subtotalGross"),
    discount_cents: money("discountTotalGross"), shipping_cents: money("shippingGross", true),
    shipping_discount_cents: money("shippingDiscountGross", true), tax_cents: money("taxTotal") };
  if (!deriveOrderMoney(toOrderMoneyHeader(translated), undefined, () => {}).reconciled) {
    throw new Error("native_account_order_money_mismatch");
  }
  return translated;
}
function line(row: CustomerOrderHistoryRow): CustomerOrderHistoryRow {
  const metadata = record(row.metadata), quote = record(record(metadata.quoteSnapshot).quote);
  if (!Object.keys(quote).length) return { ...row, unit_price_cents: minor(row.unit_amount_minor), total_cents: minor(row.line_amount_minor) };
  const lines = Array.isArray(quote.lines) ? quote.lines : [];
  const promoted = row.source_line_ordinal != null;
  const captured = record(lines[minor(promoted ? row.source_line_ordinal : row.line_ordinal) - 1]);
  const unit = record(captured.unitPriceGross), tax = record(captured.tax);
  const currency = text(record(quote.totalGross).currency), quantity = minor(row.quantity);
  const catalogUnit = minor(promoted ? row.catalog_unit_amount_minor : row.unit_amount_minor);
  const catalogTotal = minor(promoted ? row.catalog_line_amount_minor : row.line_amount_minor);
  const effective = minor(row.line_amount_minor), rate = minor(tax.vatRateBps);
  const discount = promoted ? minor(row.promotion_discount_allocated_minor) : 0;
  if (unit.currency !== currency || record(captured.lineSubtotalGross).currency !== currency
    || minor(record(captured.lineSubtotalGross).amountMinor) !== catalogUnit * Number(captured.quantity)
    || !text(captured.sku) || minor(unit.amountMinor) !== catalogUnit || !Number.isInteger(captured.quantity)
    || quantity < 1 || quantity > Number(captured.quantity) || catalogUnit * quantity !== catalogTotal
    || catalogTotal - discount !== effective || rate > 10000) {
    throw new Error("native_account_order_line_snapshot_mismatch");
  }
  return { id: row.id, sku_id: row.sku_id, quantity, unit_price_cents: catalogUnit,
    total_cents: catalogTotal, vat_rate_bps: rate, discount_allocated_cents: discount,
    effective_total_cents: effective, effective_net_cents: Math.round(effective * 10000 / (10000 + rate)),
    product_snapshot: { quoteLine: captured }, variant_snapshot: { sku: captured.sku } };
}
