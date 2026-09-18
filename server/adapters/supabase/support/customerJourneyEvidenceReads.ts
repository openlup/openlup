import type { Customer360Address } from "../../../../src/domains/support/customer360Contracts.js";
import type { CustomerJourneySnapshotResponse } from "../../../../src/domains/support/customerJourneyContracts.js";
import type { CommerceOmsSupabaseClient } from "../commerce/oms/types.js";
import {
  CYCLE_COLUMNS,
  ORDER_COLUMNS,
  OUTBOX_COLUMNS,
  PAYMENT_METHOD_COLUMNS,
  RECOVERY_TOKEN_COLUMNS,
  SUBSCRIPTION_COLUMNS,
  compact,
  datetimeOrNull,
  editBlockedReason,
  mapCommunication,
  rows,
  stringOrNull,
  type Row,
} from "../../../domains/support/customerJourneyCommon.js";
import { subscriptionGaps } from "../../../domains/support/customerJourneyProjection.js";
import {
  evidenceWarnings,
  readCustomerJourneyEvidence,
  type CustomerJourneyEvidenceRead,
} from "./customerJourneyEvidenceStatus.js";

export type CustomerJourneyEvidence<T> = { value: T; warnings: string[] };

export async function readCheckoutEvidence(client: CommerceOmsSupabaseClient, clientId: string | null, orders: Row[]): Promise<CustomerJourneyEvidence<CustomerJourneySnapshotResponse["checkout"]>> {
  const orderIds = compact(orders.map((order) => stringOrNull(order.id)));
  const orderDrafts = orders
    .filter((order) => ["draft", "pending_payment", "expired", "failed"].includes(String(order.status)))
    .map((order) => ({
      orderId: order.id,
      orderNumber: order.order_number ?? null,
      status: order.status ?? null,
      mode: order.mode ?? null,
      createdAt: order.created_at ?? null,
      updatedAt: order.updated_at ?? null,
    }));
  const recoveryTokens = orderIds.length
    ? await readCustomerJourneyEvidence("checkout_recovery_tokens", client.from("commerce_checkout_recovery_tokens").select(RECOVERY_TOKEN_COLUMNS).in("order_id", orderIds).order("created_at", { ascending: false }).range(0, 19), 20)
    : clientId
      ? await readCustomerJourneyEvidence("checkout_recovery_tokens", client.from("commerce_checkout_recovery_tokens").select(RECOVERY_TOKEN_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: false }).range(0, 19), 20)
      : observedEmpty<Row>();
  const abandonedCartEvents = orderIds.length
    ? await readCustomerJourneyEvidence("checkout_outbox", client.from("outbox_events").select(OUTBOX_COLUMNS).in("aggregate_id", orderIds)
      .in("event_type", ["commerce.checkout_recovery", "commerce.checkout.expired", "commerce.order_draft.created"])
      .order("created_at", { ascending: false }).range(0, 19), 20)
    : observedEmpty<Row>();
  return {
    value: {
      orderDrafts,
      recoveryTokens: recoveryTokens.value.map((token) => ({
      id: token.id,
      orderId: token.order_id,
      purpose: token.purpose,
      expiresAt: token.expires_at,
      usedAt: token.used_at,
      revokedAt: token.revoked_at,
      createdAt: token.created_at,
      })),
      abandonedCartEvents: abandonedCartEvents.value.map((event) => ({
      id: event.id,
      eventType: event.event_type,
      status: event.status,
      attempts: event.attempts,
      availableAt: event.available_at,
      processedAt: event.processed_at,
      createdAt: event.created_at,
      errorPresent: Boolean(event.error),
      })),
    },
    warnings: evidenceWarnings(recoveryTokens, abandonedCartEvents),
  };
}

export async function readPaymentProviderRefs(client: CommerceOmsSupabaseClient, orders: Row[]): Promise<CustomerJourneyEvidence<Row[]>> {
  const orderIds = compact(orders.map((order) => stringOrNull(order.id)));
  if (!orderIds.length) return { value: [], warnings: [] };
  const payments = await readCustomerJourneyEvidence("payment_provider_refs", client.from("commerce_payments").select("id, order_id, provider, provider_payment_id, status, updated_at").in("order_id", orderIds));
  const paymentIds = compact(payments.value.map((payment) => stringOrNull(payment.id)));
  const refs = paymentIds.length
    ? await readCustomerJourneyEvidence("payment_provider_refs", client.from("payment_external_refs").select("payment_id, provider_kind, provider_payment_id, created_at").in("payment_id", paymentIds))
    : observedEmpty<Row>();
  return { value: [
    ...payments.value.map((payment) => ({
      orderId: payment.order_id,
      paymentId: payment.id,
      provider: payment.provider,
      providerPaymentId: payment.provider_payment_id,
      status: payment.status,
      updatedAt: payment.updated_at,
    })),
    ...refs.value.map((ref) => ({
      paymentId: ref.payment_id,
      providerKind: ref.provider_kind,
      externalRef: ref.provider_payment_id,
      active: null,
      updatedAt: ref.created_at,
    })),
  ], warnings: evidenceWarnings(payments, refs) };
}

const ADDRESS_COLUMNS = "id, kind, label, recipient_name, line1, line2, postal_code, city, country, contact_phone, is_default, last_used_at";

/**
 * The addresses this subject has saved that a parcel can actually be sent to,
 * default first and then most recently used, capped at the twenty the Customer-360
 * contract carries.
 *
 * `null` rather than `[]` whenever the read did not happen — no subject, or a read
 * that failed. An empty array is the positive statement "this customer has saved
 * none", and only a read that succeeded may make it: an operator told that would
 * take a new address down by hand for a customer who already has one. The
 * contract's key is optional so that `null` can be said by omitting it, which is
 * also why a failure here degrades the picker instead of the whole snapshot.
 *
 * A `billing` row is excluded here as well as in the contract, because it is not a
 * delivery destination — repointing a subscription at one would send the food to
 * wherever the invoice goes.
 */
export async function readShippableAddresses(client: CommerceOmsSupabaseClient, clientId: string | null): Promise<Customer360Address[] | null> {
  if (!clientId) return null;
  // Kind filters in the QUERY, not only in JS: the 20-row window is cut at the
  // database, so a customer rich in billing rows must not push her shipping
  // addresses out of it. The JS filter below stays as the belt to the braces.
  const saved = await rows<Row>(client.from("addresses").select(ADDRESS_COLUMNS).eq("client_id", clientId)
    .in("kind", ["shipping", "both"])
    .order("is_default", { ascending: false }).order("last_used_at", { ascending: false }).range(0, 19)).catch(() => null);
  if (!saved) return null;
  return saved
    .filter((row) => row.kind === "shipping" || row.kind === "both")
    .sort((a, b) => Number(b.is_default === true) - Number(a.is_default === true)
      || (stringOrNull(b.last_used_at) ?? "").localeCompare(stringOrNull(a.last_used_at) ?? ""))
    .slice(0, 20)
    .flatMap(shippableAddress);
}

/**
 * Where each of this subject's subscriptions routes its next parcel today, so the
 * picker can mark the one already in force. A subscription the map does not name
 * reports a null pointer; `null` for the whole map is the read that did not
 * happen, and the contract omits the key rather than claiming every subscription
 * carries no address.
 */
export async function readSubscriptionAddressPointers(client: CommerceOmsSupabaseClient, clientId: string | null): Promise<Map<string, string | null> | null> {
  if (!clientId) return null;
  const pointers = await rows<Row>(client.from("subscriptions").select("id, shipping_address_id")
    .eq("client_id", clientId).range(0, 49)).catch(() => null);
  if (!pointers) return null;
  return new Map(pointers.flatMap((row) => {
    const subscriptionId = stringOrNull(row.id);
    return subscriptionId ? [[subscriptionId, stringOrNull(row.shipping_address_id)] as const] : [];
  }));
}

/**
 * One saved address, or nothing at all when the row lacks a part a parcel cannot
 * be delivered without. A half address rendered in a picker is worse than an
 * absent one: it looks selectable.
 */
function shippableAddress(row: Row): Customer360Address[] {
  const addressId = stringOrNull(row.id), line1 = stringOrNull(row.line1);
  const postalCode = stringOrNull(row.postal_code), city = stringOrNull(row.city), country = stringOrNull(row.country);
  if (!addressId || !line1 || !postalCode || !city || !country) return [];
  return [{
    addressId, line1, postalCode, city, country,
    label: stringOrNull(row.label),
    recipientName: stringOrNull(row.recipient_name),
    line2: stringOrNull(row.line2),
    contactPhone: stringOrNull(row.contact_phone),
    isDefault: row.is_default === true,
    kind: row.kind === "both" ? "both" : "shipping",
  }];
}

export async function readSubscriptions(client: CommerceOmsSupabaseClient, clientId: string | null, subscriptionIds: string[]): Promise<CustomerJourneyEvidence<CustomerJourneySnapshotResponse["subscriptions"]>> {
  const subscriptionList = subscriptionIds.length
    ? await readCustomerJourneyEvidence("subscription_list", client.from("subscriptions").select(SUBSCRIPTION_COLUMNS).in("id", subscriptionIds).order("created_at", { ascending: false }))
    : clientId
      ? await readCustomerJourneyEvidence("subscription_list", client.from("subscriptions").select(SUBSCRIPTION_COLUMNS).eq("client_id", clientId).order("created_at", { ascending: false }).range(0, 9), 10)
      : observedEmpty<Row>();
  if (subscriptionList.state === "unavailable") throw new Error("customer_journey_subscription_list_unavailable");
  const subs = subscriptionList.value;
  const ids = compact(subs.map((subscription) => stringOrNull(subscription.id)));
  if (!ids.length) return { value: [], warnings: evidenceWarnings(subscriptionList) };
  const [cycles, renewalOrders, paymentMethods, communicationEvents] = await Promise.all([
    readCustomerJourneyEvidence("subscription_cycles", client.from("subscription_cycles").select(CYCLE_COLUMNS).in("subscription_id", ids).order("scheduled_at", { ascending: false }).range(0, 29), 30),
    readCustomerJourneyEvidence("subscription_renewal_orders", client.from("commerce_orders").select(ORDER_COLUMNS).in("subscription_id", ids).order("created_at", { ascending: false }).range(0, 29), 30),
    readCustomerJourneyEvidence("subscription_payment_methods", client.from("commerce_payment_method_refs").select(PAYMENT_METHOD_COLUMNS).in("subscription_id", ids).order("updated_at", { ascending: false }).range(0, 19), 20),
    readCustomerJourneyEvidence("subscription_communications", client.from("communication_email_deliveries").select("id, purpose, template_slug, trigger_source, status, provider_kind, provider_message_id, queued_at, sent_at, delivered_at, terminal_at, outbox_event_id, email_send_id, aggregate_id, created_at").in("aggregate_id", ids).order("created_at", { ascending: false }).range(0, 29), 30),
  ]);

  return { value: subs.map((subscription) => {
    const subscriptionId = String(subscription.id);
    const subscriptionCycles = cycles.value.filter((cycle) => cycle.subscription_id === subscriptionId);
    const paymentMethod = paymentMethods.value.find((method) => method.subscription_id === subscriptionId) ?? null;
    return {
      subscriptionId,
      status: stringOrNull(subscription.status),
      nextCycleAt: datetimeOrNull(subscription.next_cycle_at),
      templateVersion: typeof subscription.template_version === "number" ? subscription.template_version : null,
      editBlockedReason: editBlockedReason(subscription),
      paymentMethodStatus: stringOrNull(paymentMethod?.status ?? (subscription.payment_method_ref ? "linked" : null)),
      cycles: subscriptionCycles.map((cycle) => ({
        cycleId: cycle.id,
        orderId: cycle.order_id,
        cycleNumber: cycle.cycle_number,
        status: cycle.status,
        scheduledAt: cycle.scheduled_at,
        paidAt: cycle.paid_at,
        nextRetryAt: cycle.next_retry_at,
        retryAttempt: cycle.retry_attempt,
        failureReason: cycle.failure_reason,
      })),
      renewalOrders: renewalOrders.value.filter((order) => order.subscription_id === subscriptionId).map((order) => ({
        orderId: order.id,
        orderNumber: order.order_number,
        status: order.status,
        subscriptionCycleId: order.subscription_cycle_id,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      })),
      renewalCommunications: communicationEvents.value.filter((event) => event.aggregate_id === subscriptionId).map(mapCommunication),
      gaps: subscriptionGaps(subscription, subscriptionCycles, paymentMethod).filter((gap) =>
        (!["unavailable", "windowed"].includes(cycles.state) || gap.code !== "subscription_cycles_missing")
        && (!["unavailable", "windowed"].includes(paymentMethods.state) || gap.code !== "subscription_payment_method_missing")),
    };
  }), warnings: evidenceWarnings(subscriptionList, cycles, renewalOrders, paymentMethods, communicationEvents) };
}

function observedEmpty<T extends Row>(): CustomerJourneyEvidenceRead<T> {
  return { value: [], state: "observed_empty", warning: null };
}
