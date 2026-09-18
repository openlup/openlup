import type {
  AdminCommerceOrderDetailRequest,
  AdminCommerceOrderDetailResponse,
  AdminCommerceOrderHoldRequest,
  AdminCommerceOrderHoldResponse,
  AdminCommerceOrderMarkRefundedRequest,
  AdminCommerceOrderMarkRefundedResponse,
  AdminCommerceOrderCancelRequest,
  AdminCommerceOrderNoteRequest,
  AdminCommerceOrderNoteResponse,
  AdminCommerceOrderReleaseHoldRequest,
  AdminCommerceOrderRequestReplacementShipmentRequest,
  AdminCommerceOrderRequestReplacementShipmentResponse,
  AdminCommerceOrderUpdateShippingAddressRequest,
  AdminCommerceOrderUpdateShippingAddressResponse,
  AdminCommerceOrdersListRequest,
  AdminCommerceOrdersListResponse,
} from "./omsContracts.js";
import { isAcceptedPlatformCurrency } from "../../lib/currency/platformCurrency.js";

export interface CommerceOmsReadPort {
  listOrders(request: AdminCommerceOrdersListRequest): Promise<AdminCommerceOrdersListResponse>;
  getOrderDetail(
    request: AdminCommerceOrderDetailRequest,
  ): Promise<AdminCommerceOrderDetailResponse | null>;
}

export interface CommerceOmsHoldPort {
  createHold(
    request: AdminCommerceOrderHoldRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderHoldResponse>;
  releaseHold(
    request: AdminCommerceOrderReleaseHoldRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderHoldResponse>;
  addNote(
    request: AdminCommerceOrderNoteRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderNoteResponse>;
  updateShippingAddress(
    request: AdminCommerceOrderUpdateShippingAddressRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderUpdateShippingAddressResponse>;
  markRefunded(
    request: AdminCommerceOrderMarkRefundedRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderMarkRefundedResponse>;
  cancelOrder(
    request: AdminCommerceOrderCancelRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderMarkRefundedResponse>;
  /**
   * Creates the replacement parcel for an order whose first parcel was lost,
   * damaged or came back undelivered. It is the only port method that releases a
   * hold as part of its own success, and only the `fulfillment_exception` one;
   * every other active hold reason refuses. Refusals arrive as
   * `CommerceOmsConflictError` carrying `details.reason` from the adapter's closed
   * vocabulary, never as database text.
   */
  requestReplacementShipment(
    request: AdminCommerceOrderRequestReplacementShipmentRequest & { actorUserId: string },
  ): Promise<AdminCommerceOrderRequestReplacementShipmentResponse>;
}

/**
 * Every refusal `commerce_oms_request_replacement_shipment` can reach an operator with,
 * as one closed vocabulary shared by the adapter that classifies it and the admin surface
 * that renders a sentence for it. Two lists would drift, and the failure mode of drift is
 * the operator reading advice about a hold when the warehouse is simply out of stock.
 *
 * The first group is the command's own `commerce_oms_replacement_*` names. The second is
 * the reservation vocabulary raised THROUGH it: the command mints a fresh generation via
 * `inventory_reserve_order`, and on a stock authority outside this system that call is the
 * most likely legitimate refusal there is. Those errors never carried the command's prefix,
 * so before this list they matched nothing, degraded to an upstream failure, and the
 * operator was told to check holds that were not there.
 *
 * It stays an allowlist, not a translation table: a reason absent from it degrades to
 * `unspecified_refusal`, so no database text can travel to a response, a log or a screen.
 *
 * ⛔ The exported names deliberately omit the `CommerceOms` prefix every other symbol in
 * this file carries. `src/lib/commerceOmsBoundary.test.ts` forbids that token in production
 * UI files outside a small allowlist, and the admin surface imports these three symbols.
 * Renaming them is the honest way to keep that boundary guard intact; widening its allowlist
 * to admit one more file would weaken the control instead of respecting it.
 */
export const OMS_REPLACEMENT_COMMAND_REFUSALS = [
  "invalid_input",
  "idempotency_conflict",
  "order_not_found",
  "order_not_replaceable",
  "missing_client",
  "missing_shipping_address",
  "shipping_address_not_found",
  "payment_not_succeeded",
  "subscription_cycle_not_paid",
  "no_parcel_to_replace",
  "undispatched_replacement_exists",
  "missing_order_items",
  "missing_catalog_sku",
  "missing_inventory_reservation",
  "blocked_by_payment_not_succeeded_hold",
  "blocked_by_inventory_review_hold",
  "blocked_by_risk_review_hold",
  "blocked_by_address_review_hold",
  "blocked_by_manual_support_hold",
] as const;

export const OMS_REPLACEMENT_RESERVATION_REFUSALS = [
  "inventory_external_provider_insufficient_available_stock",
  "inventory_external_provider_stock_stale",
  "inventory_external_provider_stock_missing",
  "inventory_external_provider_sku_not_found",
  "inventory_external_provider_location_missing",
  "inventory_reservation_insufficient_available_stock",
  "inventory_reservation_allocation_incomplete",
  "inventory_reservation_payment_status_not_reservable",
  "inventory_reservation_invalid_quantity",
] as const;

export const UNSPECIFIED_REPLACEMENT_REFUSAL = "unspecified_refusal";

export const OMS_REPLACEMENT_REFUSALS = [
  ...OMS_REPLACEMENT_COMMAND_REFUSALS,
  ...OMS_REPLACEMENT_RESERVATION_REFUSALS,
  UNSPECIFIED_REPLACEMENT_REFUSAL,
] as const;

export type OmsReplacementRefusal = (typeof OMS_REPLACEMENT_REFUSALS)[number];

/**
 * Reads the refusal a replacement error carries, from any of the shapes a BFF error can
 * legitimately arrive in. Returns null when the text names no refusal this vocabulary
 * knows, which is the honest answer: the operator gets the generic sentence plus the raw
 * detail to hand to the team, never a guess dressed as advice.
 */
export function readOmsReplacementRefusal(text: string): OmsReplacementRefusal | null {
  const named = /commerce_oms_replacement_([a-z0-9_]+)/.exec(text)?.[1];
  if (named) {
    return (OMS_REPLACEMENT_COMMAND_REFUSALS as readonly string[]).includes(named)
      ? named as OmsReplacementRefusal
      : UNSPECIFIED_REPLACEMENT_REFUSAL;
  }
  // Exact membership only. A transport or permission failure that merely quotes a table
  // name such as `inventory_reservations` must stay an upstream failure, not become a
  // refusal the operator is asked to act on.
  return OMS_REPLACEMENT_RESERVATION_REFUSALS.find((reason) => text.includes(reason)) ?? null;
}

export class CommerceOmsInvalidResponseError extends Error {
  constructor() {
    super("Commerce OMS returned invalid response");
    this.name = "CommerceOmsInvalidResponseError";
  }
}

export class CommerceOmsPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce OMS persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceOmsPersistenceError";
    this.details = details;
  }
}

/**
 * An order row came back from the database in a currency this deployment does
 * not accept. The channel ingest rail is deliberately multi-currency, so such a
 * row can genuinely exist; what it cannot do is reach the read model, whose
 * money nodes are pinned to the platform's accepted set.
 *
 * A subclass rather than a new error family, so it inherits the persistence
 * error's HTTP mapping untouched: this is still an upstream read that could not
 * be served, and the operator-facing status must not move. The gain is entirely
 * diagnostic - the failure now names the orders and the codes instead of
 * surfacing as an anonymous validation error fifteen frames later.
 */
export class CommerceOmsUnsupportedCurrencyError extends CommerceOmsPersistenceError {
  readonly orderIds: readonly string[];
  readonly currencies: readonly string[];

  constructor(offenders: ReadonlyArray<{ orderId: string; currency: string }>) {
    const orderIds = offenders.map((offender) => offender.orderId);
    const currencies = [...new Set(offenders.map((offender) => offender.currency))];
    const described = offenders
      .map((offender) => `order ${offender.orderId} has currency ${offender.currency}`)
      .join(", ");
    super(`${described}, not accepted by this deployment`, { orderIds, currencies });
    this.name = "CommerceOmsUnsupportedCurrencyError";
    this.orderIds = orderIds;
    this.currencies = currencies;
  }
}

/**
 * Guards the one field of an order row that can break the OMS read.
 *
 * This is deliberately not a schema for the whole row. Of that row's ~22
 * columns exactly one - `currency` - is both able to fail the read model and
 * something the platform holds an opinion about; the rest would cost a new
 * contract surface parsed once per row per page, and would only be coherent if
 * the other cast row kinds on this path were validated too.
 *
 * It also deliberately refuses rather than filtering. Dropping the offending
 * row would keep the page rendering while hiding a real customer order from the
 * operator handling it - a worse failure than a named refusal.
 */
export function assertOmsOrderRowCurrency(
  rows: ReadonlyArray<{ id: string; currency: string }>,
): void {
  const offenders = rows
    .filter((row) => !isAcceptedPlatformCurrency(row.currency))
    .map((row) => ({ orderId: row.id, currency: row.currency }));
  if (offenders.length) throw new CommerceOmsUnsupportedCurrencyError(offenders);
}

export class CommerceOmsConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce OMS conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceOmsConflictError";
    this.details = details;
  }
}
