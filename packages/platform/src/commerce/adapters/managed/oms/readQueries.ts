import type { SubscriptionCycleStatus } from "@openlup/core/subscription";
import type { OmsFulfillmentOrderRow,OmsShipmentExternalRefRow } from "../../../model/omsFulfillmentSummary.js";
import { buildOmsOrderDetailResponse,buildOmsOrderListResponse,type OmsAccountingOutboxRow,type OmsAddressRow,type OmsCommunicationDeliveryRow,type OmsCustomerRow,type OmsHoldRow,type OmsInventoryReservationRow,type OmsOperationRow,type OmsOrderItemRow,type OmsOrderRow,type OmsPaymentAttemptRow,type OmsPaymentIntentRow,type OmsPaymentTransitionRow } from "../../../model/omsReadModel.js";
import { paymentStatusForOrder,type OmsActionAvailabilityFlags } from "../../../model/omsReadModelHelpers.js";
import { ORDER_HEADER_MONEY_COLUMNS,ORDER_ITEM_MONEY_COLUMNS } from "../../../orderMoney.js";
import { omsDeliveryContactResolutionSchema,type AdminCommerceOrderDetailRequest,type AdminCommerceOrderDetailResponse,type AdminCommerceOrdersListRequest,type AdminCommerceOrdersListResponse } from "../../../oms/omsContracts.js";
import { assertOmsOrderRowCurrency,CommerceOmsPersistenceError } from "../../../oms/omsPorts.js";
import { readAccountingOutbox } from "./accounting.js";
import { readFulfillmentOrdersByOrderIds,readFulfillmentParcelsByOrderId,readShipmentRefsByOrderId,readShipmentRefsByOrderIds } from "./fulfillmentReads.js";
import { readOrderPaidOutboxEvents } from "./outboxEvents.js";
import { readActivePaymentAttempts } from "./paymentAttempts.js";
import { readQueueSelection } from "./queueSelection.js";
import { emptyOmsManagedReadProjections,type OmsManagedReadProjections } from "./readProjections.js";
import { distinctIds,type CommerceOmsStore } from "./types.js";
// `sales_channels(slug)` is the order's source channel, embedded through the only
// foreign key between the two tables and mirroring the `inventory_locations(code)`
// embed on the reservation read below. The channel id itself is deliberately not
// selected: nothing on this read path addresses a channel by id, only by slug.
const ORDER_COLUMNS = `id, order_number, client_id, status, mode, ${ORDER_HEADER_MONEY_COLUMNS}, metadata, created_at, updated_at, subscription_id, subscription_cycle_id, shipping_address_id, source_kind, source_order_ref, sales_channels(slug)`;
const ORDER_ITEM_COLUMNS = `id, order_id, sku_id, quantity, ${ORDER_ITEM_MONEY_COLUMNS}, product_snapshot, variant_snapshot`;
const ADDRESS_COLUMNS = "id, label, line1, line2, city, postal_code, country, recipient_name, contact_phone, company_name, tax_id, delivery_notes, courier_instructions";
const INVOICE_COLUMNS = "id, order_id, invoice_ref, status, provider_kind, provider_invoice_number, total_gross_cents, currency, blocked_reason, updated_at";
const COMMUNICATION_DELIVERY_COLUMNS = "id, purpose, template_slug, trigger_source, trigger_event, aggregate_type, aggregate_id, dedupe_key, status, provider_kind, provider_message_id, scheduled_due_at, expected_send_at, queued_at, first_attempt_at, sent_at, delivered_at, terminal_at, last_error_code, outbox_event_id, platform_job_run_id, email_send_id, metadata, created_at, updated_at";
export async function listCommerceOmsOrders(
  client: CommerceOmsStore,
  request: AdminCommerceOrdersListRequest,
  options: { projections?: OmsManagedReadProjections } = {},
): Promise<AdminCommerceOrdersListResponse> {
  const projections = readProjections(options.projections);
  const queue = await readQueueSelection(client, request, { currency: projections.model?.currency, projectResult: projections.projectQueue, matchSchema: projections.queueMatchSchema });
  if (!queue.orderIds.length) {
    return buildOmsOrderListResponse({
      projections: projections.model,
      orders: [],
      paymentIntents: [],
      paymentAttempts: [],
      activeHoldCounts: {},
      summaryCounts: queue.summaryCounts,
      summaryTotals: queue.summaryTotals,
      searchMatches: queue.matches,
      totalCount: queue.totalCount,
      page: request.page,
      pageSize: request.pageSize,
    });
  }
  const ordersResult = await client.query("commerce_orders").select(options.projections?.orderColumns ?? ORDER_COLUMNS).in("id", queue.orderIds);
  if (ordersResult.error) throw new CommerceOmsPersistenceError("Commerce OMS order list read failed");
  const rowsById = new Map(((ordersResult.data ?? []) as OmsOrderRow[]).map((order) => [order.id, order]));
  const orders = queue.orderIds.map((id) => rowsById.get(id)).filter((order): order is OmsOrderRow => Boolean(order));
  if (orders.length !== queue.orderIds.length) throw new CommerceOmsPersistenceError("Commerce OMS queue order hydration mismatch");
  // The cast above is the only thing asserting these rows' shape. Currency is
  // the one column that can defeat the read model, so it is checked here where
  // the order id is still in hand, not fifteen frames later inside a money node.
  assertOmsOrderRowCurrency(orders, projections.model?.currency);
  const orderIds = orders.map((order) => order.id);
  const clientIds = distinctIds(orders.map((order) => order.client_id));
  const related = await readListRelations(client, orders, orderIds, clientIds, projections);
  const fulfillmentOrderIds = related.fulfillmentOrders.map((order) => order.id);
  const [fulfillmentOperations, dispatchRefs, statusEvidence, accountingOutbox] = await Promise.all([
    projections.readFulfillmentOperations(client, fulfillmentOrderIds),
    projections.readProviderDispatchRefs(client, fulfillmentOrderIds),
    projections.readProviderStatusEvidence(client, fulfillmentOrderIds),
    readAccountingOutbox(client, related.invoices),
  ]);
  return buildOmsOrderListResponse({
    orders,
    paymentIntents: related.paymentIntents,
    paymentAttempts: related.paymentAttempts,
    activeHoldCounts: countHoldsByOrder(related.activeHolds),
    activeHoldReasons: holdReasonsByOrder(related.activeHolds),
    fulfillmentHealthDigests: projections.buildHealthDigests({ orders, paymentIntents: related.paymentIntents, fulfillmentOrders: related.fulfillmentOrders, dispatchRefs, statusEvidence }),
    customers: related.customers,
    identityExtras: related.identityExtras,
    projections: projections.model,
    orderItems: related.orderItems,
    inventoryReservations: related.reservations,
    fulfillmentOrders: related.fulfillmentOrders,
    fulfillmentOperations,
    shipmentExternalRefs: related.shipmentRefs,
    providerDispatchRefs: dispatchRefs,
    providerStatusEvidence: statusEvidence,
    releasedProviderExceptionHolds: related.releasedProviderExceptionHolds,
    accountingInvoices: related.invoices,
    accountingOutbox,
    subscriptionCycleStatuses: related.subscriptionCycleStatuses,
    summaryCounts: queue.summaryCounts,
    summaryTotals: queue.summaryTotals,
    searchMatches: queue.matches,
    totalCount: queue.totalCount,
    page: request.page,
    pageSize: request.pageSize,
  });
}
export async function getCommerceOmsOrderDetail(client: CommerceOmsStore, request: AdminCommerceOrderDetailRequest,
  options: { actionFlags?: OmsActionAvailabilityFlags; projections?: OmsManagedReadProjections } = {},
): Promise<AdminCommerceOrderDetailResponse | null> {
  const orderResult = await client.query("commerce_orders").select(options.projections?.orderColumns ?? ORDER_COLUMNS).eq("id", request.orderId).maybeSingle();
  if (orderResult.error) throw new CommerceOmsPersistenceError("Commerce OMS order detail read failed");
  if (!orderResult.data) return null;
  return readOrderDetail(client, orderResult.data as OmsOrderRow, options);
}

/** Hydrate a bounded selection without repeating its canonical header query. */
export async function getCommerceOmsOrderDetails(client: CommerceOmsStore, orderIds: string[],
  options: { actionFlags?: OmsActionAvailabilityFlags; projections?: OmsManagedReadProjections } = {},
): Promise<Array<AdminCommerceOrderDetailResponse | null>> {
  if (orderIds.length === 0) return [];
  if (orderIds.length > 25) throw new CommerceOmsPersistenceError("Commerce OMS detail batch exceeds 25 orders");
  const result = await client.query("commerce_orders").select(options.projections?.orderColumns ?? ORDER_COLUMNS).in("id", [...new Set(orderIds)]);
  if (result.error) throw new CommerceOmsPersistenceError("Commerce OMS order detail read failed");
  const orders = new Map(((result.data ?? []) as OmsOrderRow[]).map((order) => [order.id, order]));
  return Promise.all(orderIds.map((id) => {
    const order = orders.get(id);
    return order ? readOrderDetail(client, order, options) : null;
  }));
}

async function readOrderDetail(client: CommerceOmsStore, order: OmsOrderRow,
  options: { actionFlags?: OmsActionAvailabilityFlags; projections?: OmsManagedReadProjections },
): Promise<AdminCommerceOrderDetailResponse> {
  const projections = readProjections(options.projections);
  assertOmsOrderRowCurrency([order], projections.model?.currency);

  const [related, resolutionResult] = await Promise.all([
    readDetailRelations(client, order, projections),
    client.rpc("commerce_oms_resolve_delivery_contact_v1", { p_order_id: order.id }),
  ]);
  if (resolutionResult.error) throw new CommerceOmsPersistenceError("Commerce OMS delivery contact resolution failed");
  const contactResolution = omsDeliveryContactResolutionSchema.safeParse(resolutionResult.data);
  if (!contactResolution.success) throw new CommerceOmsPersistenceError("Commerce OMS delivery contact resolution was malformed");
  const intent = related.intent;
  // Every parcel, current first. Provider evidence stays keyed on the current
  // parcel; widening it would attribute a sibling's state to the live shipment.
  // Superseded parcels travel as separate support/claim nodes below.
  const parcels = related.parcels;
  const fulfillmentOrder = parcels[0] ?? null;
  const invoice = related.invoice;
  const fulfillmentOrderIds = fulfillmentOrder ? [fulfillmentOrder.id] : [];
  const [attemptsResult, transitionsResult, fulfillmentOperations, providerAttempts, dispatchRefs, statusEvidence, releasedProviderExceptionHolds, outboxResult, orderPaidOutboxResult, communicationResult] = await Promise.all([
    intent ? client.query("commerce_payment_attempts").select("id, status, provider, provider_attempt_id, next_action_kind, updated_at").eq("payment_intent_id", intent.id).order("created_at", { ascending: false }) : emptyRows(),
    intent ? client.query("commerce_payment_state_transitions").select("id, transition_kind, from_status, to_status, reason, occurred_at").eq("payment_intent_id", intent.id).order("occurred_at", { ascending: false }) : emptyRows(),
    projections.readFulfillmentOperations(client, fulfillmentOrderIds),
    projections.readProviderAttempts(client, fulfillmentOrderIds),
    projections.readProviderDispatchRefs(client, fulfillmentOrderIds),
    projections.readProviderStatusEvidence(client, fulfillmentOrderIds),
    projections.readReleasedProviderExceptionHolds(client, [order.id]),
    invoice
      ? client
        .query("accounting_invoice_issue_outbox")
        .select("invoice_id, status, attempt_count, next_attempt_at, last_error, created_at")
        .eq("invoice_id", invoice.id)
        .order("created_at", { ascending: false })
      : emptyRows(),
    readOrderPaidOutboxEvents(client, order.id),
    client
      .query("communication_email_deliveries")
      .select(COMMUNICATION_DELIVERY_COLUMNS)
      .eq("aggregate_type", "commerce_order")
      .eq("aggregate_id", order.id)
      .order("created_at", { ascending: false }),
  ]);
  if ([attemptsResult, transitionsResult, outboxResult, orderPaidOutboxResult, communicationResult].some((result) => result.error)) throw new CommerceOmsPersistenceError("Commerce OMS detail expansion read failed");
  const inboundProviderEvents = await projections.readInboundEvents(client, { order, dispatchRefs });
  const providerStockCurrent = await projections.readProviderStockCurrent(client, related.orderItems);
  const paymentAttempts = (attemptsResult.data ?? []) as OmsPaymentAttemptRow[];
  const fulfillmentHealth = projections.buildHealth({
    order,
    paymentStatus: paymentStatusForOrder(order.id, intent ? [intent] : []),
    fulfillmentOrders: fulfillmentOrder ? [fulfillmentOrder] : [],
    dispatchRefs,
    statusEvidence,
    orderPaidOutboxEvents: (orderPaidOutboxResult.data ?? []) as unknown[],
  });
  return buildOmsOrderDetailResponse({
    order,
    paymentIntent: intent,
    paymentAttempts,
    paymentTransitions: (transitionsResult.data ?? []) as OmsPaymentTransitionRow[],
    holds: related.holds,
    operations: related.operations,
    customer: related.customer,
    identityExtras: related.identityExtras,
    projections: projections.model,
    shippingAddress: related.shippingAddress,
    accountingInvoice: invoice,
    accountingOutbox: (outboxResult.data ?? []) as OmsAccountingOutboxRow[],
    communicationDeliveries: (communicationResult.data ?? []) as OmsCommunicationDeliveryRow[],
    orderItems: related.orderItems,
    inventoryReservations: related.reservations,
    fulfillmentOrders: fulfillmentOrder ? [fulfillmentOrder] : [],
    supersededFulfillmentOrders: parcels.slice(1),
    fulfillmentOperations,
    shipmentExternalRefs: related.shipmentRefs,
    providerAttempts,
    providerDispatchRefs: dispatchRefs,
    providerStatusEvidence: statusEvidence,
    releasedProviderExceptionHolds,
    fulfillmentHealth,
    inboundProviderEvents,
    providerStockCurrent,
    subscriptionCycleStatus: related.cycleStatus,
    subscriptionCyclePaidAt: related.cyclePaidAt, subscriptionNextCycleAt: related.subscriptionNextCycleAt,
    actionFlags: options.actionFlags,
    deliveryContactResolution: contactResolution.data,
  });
}
async function readListRelations(
  client: CommerceOmsStore,
  orders: OmsOrderRow[],
  orderIds: string[],
  clientIds: string[],
  projections: ReturnType<typeof readProjections>,
) {
  const cycleIds = distinctIds(orders.map((order) => order.subscription_cycle_id ?? null));
  const [intent, hold, releasedProviderExceptionHolds, customer, identityExtras, items, reservations, fulfillment, shipmentRefs, invoice, cycles] = await Promise.all([
    orderIds.length ? client.query("commerce_payment_intents").select("id, order_id, payment_id, status, active_attempt_id, provider_payment_id, updated_at").in("order_id", orderIds) : emptyRows(),
    orderIds.length ? client.query("commerce_order_holds").select("order_id, reason").in("order_id", orderIds).eq("status", "active") : emptyRows(),
    projections.readReleasedProviderExceptionHolds(client, orderIds),
    clientIds.length ? client.query("clients").select("id, email, first_name, last_name, phone, lifecycle_stage").in("id", clientIds) : emptyRows(),
    projections.readIdentity(client, orders, "list"),
    orderIds.length ? client.query("commerce_order_items").select(ORDER_ITEM_COLUMNS).in("order_id", orderIds) : emptyRows(),
    orderIds.length ? client.query("inventory_reservations").select("id, order_id, order_item_id, quantity, status, expires_at, location_id, inventory_locations!inventory_reservations_location_id_fkey(code)").in("order_id", orderIds) : emptyRows(),
    readFulfillmentOrdersByOrderIds(client, orderIds),
    readShipmentRefsByOrderIds(client, orderIds),
    orderIds.length ? client.query("accounting_invoices").select(projections.invoiceColumns ?? INVOICE_COLUMNS).in("order_id", orderIds).is("correction_of_invoice_id", null) : emptyRows(),
    cycleIds.length ? client.query("subscription_cycles").select("id, status").in("id", cycleIds) : emptyRows(),
  ]);
  if (intent.error || hold.error || customer.error || items.error || reservations.error || fulfillment.error || shipmentRefs.error || invoice.error || cycles.error) {
    throw new CommerceOmsPersistenceError("Commerce OMS related list read failed");
  }
  const paymentIntents = (intent.data ?? []) as OmsPaymentIntentRow[];
  const paymentAttempts = await readActivePaymentAttempts(client, paymentIntents);
  return {
    paymentIntents,
    paymentAttempts,
    activeHolds: (hold.data ?? []) as OmsActiveHoldRow[],
    releasedProviderExceptionHolds,
    customers: (customer.data ?? []) as OmsCustomerRow[],
    identityExtras,
    orderItems: (items.data ?? []) as OmsOrderItemRow[],
    reservations: (reservations.data ?? []) as OmsInventoryReservationRow[],
    fulfillmentOrders: (fulfillment.data ?? []) as OmsFulfillmentOrderRow[],
    shipmentRefs: (shipmentRefs.data ?? []) as OmsShipmentExternalRefRow[],
    invoices: ((invoice.data ?? []) as unknown[]).map(projections.mapInvoice),
    subscriptionCycleStatuses: Object.fromEntries(((cycles.data ?? []) as Array<{ id: string; status: SubscriptionCycleStatus | null }>).map((cycle) => [cycle.id, cycle.status])) as Record<string, SubscriptionCycleStatus | null>,
  };
}
async function readDetailRelations(client: CommerceOmsStore, order: OmsOrderRow, projections: ReturnType<typeof readProjections>) {
  const [intent, holds, operations, items, cycle, reservations, fulfillment, shipmentRefs, customer, identityExtras, address, invoice, subscription] = await Promise.all([
    client.query("commerce_payment_intents").select("id, order_id, payment_id, status, active_attempt_id, provider_payment_id, updated_at").eq("order_id", order.id).maybeSingle(),
    client.query("commerce_order_holds").select("id, order_id, status, reason, note, created_at, released_at").eq("order_id", order.id).order("created_at", { ascending: false }),
    client.query("commerce_order_operations").select("id, order_id, operation_type, hold_id, actor_user_id, occurred_at, payload").eq("order_id", order.id).order("occurred_at", { ascending: false }),
    client.query("commerce_order_items").select(ORDER_ITEM_COLUMNS).eq("order_id", order.id),
    order.subscription_cycle_id ? client.query("subscription_cycles").select("status, paid_at").eq("id", order.subscription_cycle_id).maybeSingle() : emptyOne(),
    client.query("inventory_reservations").select("id, order_id, order_item_id, quantity, status, expires_at, location_id, inventory_locations!inventory_reservations_location_id_fkey(code)").eq("order_id", order.id).order("created_at", { ascending: false }),
    readFulfillmentParcelsByOrderId(client, order.id),
    readShipmentRefsByOrderId(client, order.id),
    order.client_id ? client.query("clients").select("id, email, first_name, last_name, phone, lifecycle_stage").eq("id", order.client_id).maybeSingle() : emptyOne(),
    projections.readIdentity(client, [order], "detail"),
    order.shipping_address_id ? client.query("addresses").select(ADDRESS_COLUMNS).eq("id", order.shipping_address_id).maybeSingle() : emptyOne(),
    client.query("accounting_invoices").select(projections.invoiceColumns ?? INVOICE_COLUMNS).eq("order_id", order.id).is("correction_of_invoice_id", null).maybeSingle(),
    order.subscription_id ? client.query("subscriptions").select("next_cycle_at").eq("id", order.subscription_id).maybeSingle() : emptyOne(), // read-only display enrichment (next CHARGE date); deliberately absent from the error check below so a failure degrades to a dash instead of failing the whole detail
  ]);
  if (intent.error || holds.error || operations.error || items.error || cycle.error || reservations.error || fulfillment.error || shipmentRefs.error || customer.error || address.error || invoice.error) {
    throw new CommerceOmsPersistenceError("Commerce OMS related detail read failed");
  }
  return {
    intent: (intent.data ?? null) as OmsPaymentIntentRow | null,
    holds: (holds.data ?? []) as OmsHoldRow[],
    operations: (operations.data ?? []) as OmsOperationRow[],
    orderItems: (items.data ?? []) as OmsOrderItemRow[],
    cycleStatus: ((cycle.data as { status?: SubscriptionCycleStatus } | null)?.status ?? null),
    cyclePaidAt: ((cycle.data as { paid_at?: string | null } | null)?.paid_at ?? null), subscriptionNextCycleAt: ((subscription.data as { next_cycle_at?: string | null } | null)?.next_cycle_at ?? null),
    reservations: (reservations.data ?? []) as OmsInventoryReservationRow[],
    parcels: (fulfillment.data ?? []) as OmsFulfillmentOrderRow[],
    shipmentRefs: (shipmentRefs.data ?? []) as OmsShipmentExternalRefRow[],
    customer: (customer.data ?? null) as OmsCustomerRow | null,
    identityExtras: identityExtras[order.id],
    shippingAddress: (address.data ?? null) as OmsAddressRow | null,
    invoice: invoice.data ? projections.mapInvoice(invoice.data) : null,
  };
}

// One set of rows answers both "how many" and "what for"; reasons distinct, first-seen order.
type OmsActiveHoldRow = { order_id: string; reason: OmsHoldRow["reason"] };
function countHoldsByOrder(rows: OmsActiveHoldRow[]): Record<string, number> { return rows.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.order_id]: (counts[row.order_id] ?? 0) + 1 }), {}); }
function holdReasonsByOrder(rows: OmsActiveHoldRow[]): Record<string, Array<OmsHoldRow["reason"]>> { return rows.reduce<Record<string, Array<OmsHoldRow["reason"]>>>((reasons, row) => ({ ...reasons, [row.order_id]: [...new Set([...(reasons[row.order_id] ?? []), row.reason])] }), {}); }

function emptyRows() { return Promise.resolve({ data: [], error: null }); }
function emptyOne() { return Promise.resolve({ data: null, error: null }); }

function readProjections(projections?: OmsManagedReadProjections) { return { ...emptyOmsManagedReadProjections, ...projections }; }
