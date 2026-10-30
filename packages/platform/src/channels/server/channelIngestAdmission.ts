import {
  CHANNEL_ORDER_PAID_EXTERNALLY_STATE,
  type NormalizedChannelOrder,
} from "../orderContracts.js";
import type { ChannelIngestChannelRecord } from "../channelIngestStorePort.js";
// Settlement acceptance is explicit composition data. The normalized wire currency stays open;
// this gate performs the same membership check without importing an ambient profile.


// The gate every normalized order passes before the saga writes anything.
//
// Admission is deliberately separate from the saga and deliberately PURE: it decides whether this
// deployment is willing to act on an order at all, using only the order and the channel row. That
// makes the whole refusal set testable without a database, and it keeps the saga free of policy.

/**
 * Refuses a rehearsal settlement where a rehearsal must never settle. A no-op connector reports an
 * order as already paid without any money having moved anywhere; admitting one in production would
 * create a paid order for a charge that does not exist. Mirrors
 * `NoopSettlementNotAllowedError` in the payment registry, which guards the same class of mistake
 * on the payment side.
 */
export class NoopChannelSettlementNotAllowedError extends Error {
  readonly connectorKind: string;

  constructor(connectorKind: string) {
    super(`No-op channel settlement is not allowed here: ${connectorKind}`);
    this.name = "NoopChannelSettlementNotAllowedError";
    this.connectorKind = connectorKind;
  }
}

export type ChannelAdmissionRefusal =
  | "channel_not_found"
  | "channel_not_active"
  | "delivery_selection_undeclared"
  | "unsupported_payment_state"
  | "currency_not_accepted"
  | "currency_mismatch";

export type ChannelAdmissionResult =
  | { admitted: true; channel: ChannelIngestChannelRecord }
  | { admitted: false; refusal: ChannelAdmissionRefusal; detail: string };

/** Connector kinds that settle nothing. Open list; a real connector never appears here. */
export const NOOP_CHANNEL_CONNECTOR_KINDS: readonly string[] = ["noop_channel"];

export interface ChannelAdmissionInput {
  order: NormalizedChannelOrder;
  channel: ChannelIngestChannelRecord | null;
  /**
   * Every currency this deployment will settle in, injected rather than read.
   *
   * REQUIRED, AND DELIBERATELY WITHOUT A DEFAULT. An optional field defaulting to "accept
   * everything" would let a future composition root re-create the exact hole this check closes,
   * and it would do so silently, because forgetting a field is invisible. Required means the
   * compiler asks the question of every root that ever builds this input.
   *
   * A LIST RATHER THAN A SINGLE CODE, for the same reason the platform module keeps the default
   * and the accepted set apart: "which currency do we price in" and "which will we take" are
   * different questions, and a platform that conflates them grows a currency fallback.
   */
  acceptedCurrencies: readonly string[];
  /** True in the one environment where a simulated settlement must never be believed. */
  noopSettlementForbidden: boolean;
  /** Paid physical debt can outlive current commercial enablement. */
  retainedPaidCapture?: boolean;
}

export function admitChannelOrder(input: ChannelAdmissionInput): ChannelAdmissionResult {
  const { order, channel } = input;

  if (!channel) {
    return {
      admitted: false,
      refusal: "channel_not_found",
      detail: `no registered channel for slug ${order.channelSlug}`,
    };
  }

  // 'testing' is admitted on purpose: that status exists so an operator can drive real orders
  // through a surface before opening it. 'disabled' and 'sunset' are not.
  if (!input.retainedPaidCapture && channel.status !== "active" && channel.status !== "testing") {
    return {
      admitted: false,
      refusal: "channel_not_active",
      detail: `channel ${channel.slug} is ${channel.status}`,
    };
  }

  // Require explicit delivery selection before ledger or money effects; infer no provider.
  if (!channel.deliverySelection) {
    return {
      admitted: false,
      refusal: "delivery_selection_undeclared",
      detail: `channel ${channel.slug} has declared no delivery selection`,
    };
  }

  // Only externally collected payment is admitted; unknown payment states refuse.
  if (order.payment.state !== CHANNEL_ORDER_PAID_EXTERNALLY_STATE) {
    return {
      admitted: false,
      refusal: "unsupported_payment_state",
      detail: `payment state ${order.payment.state} is not admitted`,
    };
  }

  // Validate both currencies before comparing them: matching unsupported currencies still refuse.
  const unaccepted = [channel.currency, order.currency].find(
    (code) => !input.acceptedCurrencies.includes(code),
  );
  if (unaccepted !== undefined) {
    return {
      admitted: false,
      refusal: "currency_not_accepted",
      detail: `currency ${unaccepted} is not settled here (channel ${channel.currency}, order ${order.currency})`,
    };
  }

  if (order.currency !== channel.currency) {
    return {
      admitted: false,
      refusal: "currency_mismatch",
      detail: `order currency ${order.currency} does not match channel currency ${channel.currency}`,
    };
  }

  // Thrown rather than returned, and last, on purpose. The six refusals above are ordinary facts
  // about one order or its surface; this one says the DEPLOYMENT is misconfigured, and a caller
  // that quietly recorded it as a per-order refusal would hide that.
  if (
    input.noopSettlementForbidden &&
    NOOP_CHANNEL_CONNECTOR_KINDS.includes(channel.connectorProviderKind)
  ) {
    throw new NoopChannelSettlementNotAllowedError(channel.connectorProviderKind);
  }

  return { admitted: true, channel };
}
