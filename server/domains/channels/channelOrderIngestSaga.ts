import {
  isInsufficientStockError,
  type ChannelIngestChannelReadPort,
  type ChannelIngestOrderItemReadPort,
  type ChannelIngestPaymentControlPort,
  type ChannelIngestReservationPort,
  type ChannelIngestStatus,
  type ChannelIngestStorePort,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import type { ChannelBundleReadPort } from "../../../src/domains/channels/bundleLineExpansion.js";
import type { NormalizedChannelOrder } from "../../../src/domains/channels/orderContracts.js";
import { admitChannelOrder } from "./channelIngestAdmission.js";
import { resolveBundleExpansion } from "./channelBundleIngestStep.js";
import {
  fileBundleRefusal,
  quarantineOrderRefusal,
  readMessage,
} from "./channelIngestRefusals.js";

// The channel order ingest saga: a normalized external order becomes a fully-valid `paid` order of
// this shop, or it stops somewhere an operator can see.
//
// THE STEP ORDER IS THE CHECKOUT ORDER, AND THAT IS THE WHOLE POINT. reserve -> intent -> attempt
// -> event -> apply. `commerceRuntimeService.startRuntime` walks exactly this sequence for a
// storefront checkout, and the reason is the same here: stock is taken BEFORE the payment rail is
// touched, so the only orders that can ever reach `paid` are orders whose stock is already held.
// An order that cannot be stocked never acquires a payment intent, so it can never be settled.
//
// WHAT IS DIFFERENT FROM CHECKOUT, AND WHY. The money has already moved on the far side. There is
// no provider to call, no redirect, no waiting: the attempt is recorded from the settlement
// reference the marketplace gave us, the event is synthesised from the same reference, and the
// result is applied in the same run. `signature_verified` is true because the trust boundary was
// crossed upstream, at the connector, not here.
//
// EVERY STEP IS REPLAYABLE TO THE SAME IDS. The keys below are deterministic functions of
// (channel, external order, step), so a run that dies anywhere and restarts from the top re-derives
// the same ledger row, the same client, the same address, the same order, the same reservations and
// the same payment intent. Resume is therefore just "run it again", and there is no resume-specific
// code path that could rot.

export type ChannelIngestOutcome =
  | { kind: "settled"; ledgerId: string; orderId: string; paymentIntentId: string }
  | { kind: "blocked_stock"; ledgerId: string; orderId: string; detail: string }
  | { kind: "quarantined"; ledgerId: string | null; reason: string; detail: string }
  | { kind: "refused"; refusal: string; detail: string }
  | { kind: "replayed"; ledgerId: string; orderId: string };

export interface ChannelOrderIngestSagaDeps {
  store: ChannelIngestStorePort;
  channels: ChannelIngestChannelReadPort;
  reservations: ChannelIngestReservationPort;
  orderItems: ChannelIngestOrderItemReadPort;
  payments: ChannelIngestPaymentControlPort;
  /**
   * The catalogue read that turns a wire BUNDLE line into component lines. Optional, and its
   * absence is a REFUSAL rather than a silent pass-through: a deployment that cannot resolve
   * bundles must quarantine a bundle line for an operator, not write an order missing it.
   */
  bundles?: ChannelBundleReadPort;
  /**
   * Every currency this deployment will settle in. Required and undefaulted all the way down to
   * admission, so that no deployment can ingest an order in a currency it cannot price.
   */
  acceptedCurrencies: readonly string[];
  /** True exactly where a simulated settlement must never be believed. */
  noopSettlementForbidden: boolean;
}

/**
 * The provider a declared selection names, normalized exactly as every other reader of this object
 * normalizes it: trimmed, lowercased, blank is nothing. Never inferred from a carrier.
 */
function readProviderKind(selection: Record<string, unknown> | null): string | null {
  const providerKind = selection?.providerKind;
  return typeof providerKind === "string" && providerKind.trim()
    ? providerKind.trim().toLowerCase()
    : null;
}

/** `ch:{channelId}:ord:{externalOrderRef}:{step}` — the saga's whole idempotency scheme. */
export function channelIngestKey(channelId: string, externalOrderRef: string, step: string): string {
  return `ch:${channelId}:ord:${externalOrderRef}:${step}`;
}

export async function runChannelOrderIngest(
  deps: ChannelOrderIngestSagaDeps,
  order: NormalizedChannelOrder,
): Promise<ChannelIngestOutcome> {
  const channel = await deps.channels.readChannelBySlug(order.channelSlug);
  const admission = admitChannelOrder({
    order,
    channel,
    acceptedCurrencies: deps.acceptedCurrencies,
    noopSettlementForbidden: deps.noopSettlementForbidden,
  });
  // Compared against the literal rather than negated: this file reaches the non-strict `scripts`
  // project through the B5 local-BFF plugin, and `!admission.admitted` does not narrow a boolean
  // discriminant when `strictNullChecks` is off. Same branch, same behavior, narrows in both.
  if (admission.admitted === false) {
    // Refused before anything durable exists. A refusal here is about the DELIVERY rather than the
    // order's contents, so it is reported to the caller rather than filed as operator work; the
    // route wave decides whether to acknowledge or fail the delivery closed.
    return { kind: "refused", refusal: admission.refusal, detail: admission.detail };
  }
  const admitted = admission.channel;
  const key = (step: string) => channelIngestKey(admitted.id, order.externalOrderRef, step);

  const ledger = await deps.store.recordInboundEvent({
    channelId: admitted.id,
    externalOrderRef: order.externalOrderRef,
    externalOrderRevision: order.externalOrderRevision,
    providerEventId: order.providerEventId,
    normalized: order,
  });

  // A far side reporting a different revision of an order this deployment already built. The store
  // mutated nothing; neither does the saga.
  if (ledger.conflict === "revision_conflict") {
    await deps.store.quarantine({
      channelId: admitted.id,
      connectionId: admitted.connectionId,
      providerEventId: order.providerEventId,
      externalOrderRef: order.externalOrderRef,
      vocabulary: order.externalOrderRevision ?? "(no revision)",
      reason: "revision_conflict",
      payload: {
        recordedRevision: ledger.externalOrderRevision,
        deliveredRevision: order.externalOrderRevision,
        ledgerStatus: ledger.status,
      },
    });
    return {
      kind: "quarantined",
      ledgerId: ledger.id,
      reason: "revision_conflict",
      detail: `recorded ${ledger.externalOrderRevision ?? "null"}, delivered ${order.externalOrderRevision ?? "null"}`,
    };
  }

  if (ledger.status === "done" && ledger.orderId) {
    return { kind: "replayed", ledgerId: ledger.id, orderId: ledger.orderId };
  }

  // The ids this mints are recorded on the ledger rather than carried in a local, so a resume that
  // re-enters below this line reads them back instead of depending on this call having happened.
  await deps.store.upsertBuyer({
    ledgerId: ledger.id,
    buyer: order.buyer,
    shipTo: order.shipTo,
  });

  // THE BUNDLE STEP SITS BEFORE THE ORDER, AND THAT IS THE POINT. A bundle code this catalogue
  // cannot sell today is operator work, and it must be discovered while there is still no order row
  // to leave half-written -- the same reason the order RPC resolves every line before it inserts
  // anything. The step is deterministic in its inputs, so a resume recomputes the same component
  // set under the same idempotency key.
  const bundleStep = await resolveBundleExpansion({
    bundles: deps.bundles,
    order,
    currency: admitted.currency,
  });
  if (bundleStep.ok === false) {
    return fileBundleRefusal(deps.store, {
      order,
      channel: admitted,
      ledgerId: ledger.id,
      refusal: bundleStep.refusal,
    });
  }
  const expandedLines = bundleStep.lines;

  let orderId: string;
  try {
    const created = await deps.store.createChannelOrder({
      idempotencyKey: key("order"),
      ledgerId: ledger.id,
      expandedLines,
    });
    orderId = created.orderId;
  } catch (error) {
    return quarantineOrderRefusal(deps.store, {
      order,
      channel: admitted,
      ledgerId: ledger.id,
      error,
    });
  }

  // STOCK BEFORE MONEY. Everything after this line assumes the order's stock is held.
  const items = await deps.orderItems.readOrderItems(orderId);
  try {
    await deps.reservations.reserveChannelOrderItems({
      idempotencyKey: key("inventory"),
      orderId,
      items,
      metadata: { source: "channels.ingest.v0", channelSlug: admitted.slug },
      // ONE STOCK AUTHORITY FOR ONE SHELF. The storefront derives this from the selection the
      // buyer made; a channel order derives it from the selection the SURFACE declared, which is
      // the same object read the same way. Admission has already refused a surface without one,
      // so the only way this is null is a selection that names no provider -- and a null here
      // means local balances, which is what the boundary already does for a manual shipment.
      providerKind: readProviderKind(admitted.deliverySelection),
    });
  } catch (error) {
    if (!isInsufficientStockError(error)) throw error;
    // THE BLOCKED-STOCK POSTURE. The order stays a draft: no payment intent, no settlement, no
    // `commerce.order.paid`. Its buyer has already been charged on the far side, so this is an
    // operator problem to solve with stock, not an order to cancel from here. A resume re-enters
    // at this same step under this same key.
    const detail = readMessage(error);
    await deps.store.advanceLedger({
      ledgerId: ledger.id,
      toStatus: "blocked_stock",
      lastError: detail,
    });
    return { kind: "blocked_stock", ledgerId: ledger.id, orderId, detail };
  }
  await advance(deps, ledger.id, "reserved");

  const paymentIntentId = await settle(deps, { order, channel: admitted, orderId, key });
  await deps.store.advanceLedger({ ledgerId: ledger.id, toStatus: "settled", paymentIntentId });
  await advance(deps, ledger.id, "done");

  return { kind: "settled", ledgerId: ledger.id, orderId, paymentIntentId };
}

async function settle(
  deps: ChannelOrderIngestSagaDeps,
  context: {
    order: NormalizedChannelOrder;
    channel: { id: string; slug: string; currency: string; settlementProviderKind: string };
    orderId: string;
    key: (step: string) => string;
  },
): Promise<string> {
  const { order, channel, orderId, key } = context;
  const amountMinor = order.totals.grandTotalMinor;
  const settlementRef = order.payment.externalPaymentRef;

  const intent = await deps.payments.createIntent({
    idempotencyKey: key("payment-intent"),
    orderId,
    amountMinor,
    currency: channel.currency,
    metadata: {
      source: "channels.ingest.v0",
      channelSlug: channel.slug,
      externalOrderRef: order.externalOrderRef,
    },
  });

  // The attempt IS the marketplace's collection. `provider` is the channel's declared settlement
  // kind rather than a payment brand, and `providerAttemptId` is the far side's payment reference —
  // which is what makes a later reconciliation able to find this money on both sides.
  await deps.payments.recordAttempt({
    idempotencyKey: key("payment-attempt"),
    paymentIntentId: intent.paymentIntentId,
    provider: channel.settlementProviderKind,
    providerAttemptId: settlementRef,
    requestPayload: { source: "channels.ingest.v0", externalOrderRef: order.externalOrderRef },
    responsePayload: { providerCall: false, collectedBy: "channel" },
  });

  // Synthesised from the settlement reference, and suffixed so it can never collide with a real
  // provider event carrying the bare reference. The control plane's amount equality check against
  // the intent is the free money reconciliation: a marketplace that reports one total and settles
  // another is refused here rather than discovered in an accounting period.
  const event = await deps.payments.ingestSettlementEvent({
    provider: channel.settlementProviderKind,
    providerEventId: `${settlementRef}:settlement`,
    providerPaymentId: settlementRef,
    paymentIntentId: intent.paymentIntentId,
    amountMinor,
    currency: channel.currency,
    payload: { source: "channels.ingest.v0", externalOrderRef: order.externalOrderRef },
  });

  await deps.payments.applySucceeded({
    idempotencyKey: key("payment-result"),
    orderId,
    paymentIntentId: intent.paymentIntentId,
    paymentEventId: event.paymentEventId,
    // The instant the buyer actually paid, on the far side. Not now: this order may have been
    // collected hours before a poll ever saw it.
    occurredAt: order.payment.paidAt,
  });

  return intent.paymentIntentId;
}

async function advance(
  deps: ChannelOrderIngestSagaDeps,
  ledgerId: string,
  toStatus: ChannelIngestStatus,
): Promise<void> {
  await deps.store.advanceLedger({ ledgerId, toStatus });
}
