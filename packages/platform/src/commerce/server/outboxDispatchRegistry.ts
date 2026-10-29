import type { CommerceEmailRuntime } from "./emailRuntime.js";
// Registry = the single source of truth for which event types this wave
// claims. The claim allowlist is derived from its keys, so the PSP-blocked
// event types stay structurally unclaimable until their handlers register.
import type { OutboxHandlerDescriptor } from "@openlup/core/outbox";
import { composeOutboxHandlerDescriptors, assertOutboxRegistryDescriptors } from "./outboxDispatchRegistryComposition.js";
import type { OutboxHandler, OutboxHandlerRegistry } from "../outboxDispatchContracts.js";
import type {
  OrderPaymentLifecyclePort,
  OrderPaidLinesPort,
  OrderRecipientPort,
  TransactionalEmailPort,
} from "../outboxOrderDraftEmailPorts.js";
import { createOutboxOrderDraftEmailHandler, outboxOrderDraftEmailDescriptor } from "./outboxOrderDraftEmailHandler.js";
import { createOutboxCheckoutRecoveryEmailHandler, outboxCheckoutRecoveryEmailDescriptor } from "./outboxCheckoutRecoveryEmailHandler.js";
import {
  createOutboxOrderPaidEmailHandler, outboxOrderPaidEmailDescriptor,
  type OrderPaidParcelNoteReader,
} from "./outboxOrderPaidEmailHandler.js";
import { createOutboxPaymentFailedEmailHandler, outboxPaymentFailedEmailDescriptor } from "./outboxPaymentFailedEmailHandler.js";
import { createOutboxCheckoutExpiredEmailHandler, outboxCheckoutExpiredEmailDescriptor } from "./outboxCheckoutExpiredEmailHandler.js";
import { createOutboxOrderRefundedEmailHandler, outboxOrderRefundedEmailDescriptor } from "./outboxOrderRefundedEmailHandler.js";
import { createOutboxShipmentDispatchedEmailHandler, outboxShipmentDispatchedEmailDescriptor } from "./outboxShipmentDispatchedEmailHandler.js";
import {
  createOutboxShipmentDeliveredEmailHandler, outboxShipmentDeliveredEmailDescriptor,
  type DeliveredEmailProviderKindReader,
} from "./outboxShipmentDeliveredEmailHandler.js";
import { createOutboxShipmentExceptionEmailHandler, outboxShipmentExceptionEmailDescriptor } from "./outboxShipmentExceptionEmailHandler.js";
import {
  createOutboxReturnApprovedEmailHandler, outboxReturnApprovedEmailDescriptor,
  createOutboxReturnRejectedEmailHandler, outboxReturnRejectedEmailDescriptor,
} from "./outboxReturnEmailHandlers.js";
import type { OrderPaidFulfillmentPort } from "./outboxOrderPaidFulfillmentPorts.js";
import {
  createOutboxOrderPaidFulfillmentHandler, outboxOrderPaidFulfillmentDescriptor,
  type OrderPaidRiskAssessmentPort,
} from "./outboxOrderPaidFulfillmentHandler.js";
import {
  platformOwnsBuyerEmail,
  type OrderBuyerCommsPolicy,
} from "../salesChannelEnvelope.js";

/**
 * Reads the sales-source buyer-comms policy for one order. `null` is
 * the answer for an order that names no channel — a storefront order, or one
 * that predates the source axis.
 *
 * Read on every event so changes to `sales_channels.buyer_comms_owner` take
 * effect on the next dispatch. A cached policy could keep sending after
 * ownership has changed.
 */
export interface OrderBuyerCommsPolicyReader {
  readOrderBuyerCommsPolicy(orderUuid: string): Promise<OrderBuyerCommsPolicy | null>;
}

export type TransactionalEmailRegistryDeps<Locale extends string = string> = {
  runtime: CommerceEmailRuntime<Locale>;
  emailPort: TransactionalEmailPort<Locale>;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
  orderPaidLinesPort: OrderPaidLinesPort;
  // Optional adopter note for the paid receipt; absent keeps today's receipt.
  orderPaidParcelNote?: OrderPaidParcelNoteReader<Locale>;
  // The delivered-email handler suppresses OUR delivered email for providers whose
  // capability profile owns the notice (none today). Absent only in
  // tests/non-transactional composition.
  deliveredProviderKindReader?: DeliveredEmailProviderKindReader;
  /** Live channel-ownership reader for buyer-facing email suppression. Hosts
   * that need channel ownership enforced must bind it; omission leaves those
   * handlers unsuppressed. */
  buyerCommsPolicyReader?: OrderBuyerCommsPolicyReader;
};

function readOrderUuid(payload: Record<string, unknown>): string | null {
  const value = payload.orderUuid;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Wraps ONE buyer-facing email handler so a channel that owns buyer
 * communication does not also get ours.
 *
 * WHY THE WRAPPER IS AT THE HANDLER AND NOT AT THE TRIGGER. The checkout email
 * reconciler (`commerce_reconcile_checkout_email_outbox`) back-fills a `commerce.order.paid.email`
 * row for EVERY order that reads `paid` and has none, keyed only on the order
 * id — it does not look at `source_kind`, and outboxDispatchRuntime runs it
 * inline immediately before the dispatch worker in the same invocation. A
 * trigger-level or emitter-level suppression would therefore be undone on the
 * very next reconcile pass, silently, and the buyer would get the email anyway.
 * The dispatcher is the last place that can still decide.
 *
 * Recorded as `processed` rather than `discard` so the event settles once and
 * never retries. `skipped` is one of the DELIVERY_LIFECYCLE_METADATA_KEYS below,
 * so the email-delivery lifecycle trigger reads the suppression as a skip with a
 * reason instead of leaving a delivery hanging — the same shape the
 * carrier-owned delivered notice already uses.
 */
function suppressForChannel(
  handler: OutboxHandler,
  reader: OrderBuyerCommsPolicyReader | undefined,
): OutboxHandler {
  if (!reader) return handler;
  return {
    eventType: handler.eventType,
    timeoutMs: handler.timeoutMs,
    async handle(row, signal, execution) {
      const orderUuid = readOrderUuid(row.payload);
      // A payload with no usable order id is not a policy question. Hand it to
      // the handler, whose own contract parse produces the right discard rather
      // than this wrapper inventing a second failure mode for the same row.
      if (orderUuid !== null) {
        const policy = await reader.readOrderBuyerCommsPolicy(orderUuid);
        if (!platformOwnsBuyerEmail(policy)) {
          return { kind: "processed", detail: { skipped: "channel_owns_buyer_comms" } };
        }
      }
      return handler.handle(row, signal, execution);
    },
  };
}

export function describeCoreOutboxHandlers(selection: {
  transactionalEmail: boolean; fulfillmentEnabled: boolean;
}): OutboxHandlerDescriptor[] {
  return [
    ...(selection.transactionalEmail ? [
      outboxOrderDraftEmailDescriptor, outboxCheckoutRecoveryEmailDescriptor,
      outboxOrderPaidEmailDescriptor, outboxPaymentFailedEmailDescriptor,
      outboxCheckoutExpiredEmailDescriptor, outboxOrderRefundedEmailDescriptor,
      outboxShipmentDispatchedEmailDescriptor, outboxShipmentDeliveredEmailDescriptor,
      outboxShipmentExceptionEmailDescriptor, outboxReturnApprovedEmailDescriptor,
      outboxReturnRejectedEmailDescriptor,
    ] : []),
    ...(selection.fulfillmentEnabled ? [outboxOrderPaidFulfillmentDescriptor] : []),
  ];
}

export function createOutboxDispatchRegistry<Locale extends string>(deps: {
  /** Bind the existing outbox rail's composition; commerce owns no second rail. */
  uniqueRegistry(handlers: readonly OutboxHandler[]): OutboxHandlerRegistry;
  transactionalEmail?: TransactionalEmailRegistryDeps<Locale>;
  fulfillmentPort?: OrderPaidFulfillmentPort;
  // Optional risk seam, evaluated per-handle via the thunk so the flag-OFF
  // posture can ack without side effects. When absent/disabled, fulfillment runs
  // exactly as before.
  riskPort?: OrderPaidRiskAssessmentPort;
  riskEnabled?: boolean;
  // Read once at job construction. When false, the fulfillment event type is not
  // registered, so commerce.order.paid rows stay unclaimed for later activation.
  fulfillmentEnabled: boolean;
  // Handlers from OTHER domains (subscription, accounting, …), composed by the
  // job so this commerce file never imports cross-domain code. Each must claim a
  // distinct event type. Appended after the commerce handlers.
  extraHandlers?: readonly OutboxHandler[];
  expectedDescriptors?: () => readonly OutboxHandlerDescriptor[];
}): OutboxHandlerRegistry {
  // Applied to the buyer-facing set below. The four email handlers it is NOT
  // applied to are structurally unreachable for a channel order on the ingest
  // path this repository ships, and each is asserted rather than assumed:
  //   - order-draft-created: emitted INSIDE `commerce_create_order_draft`.
  //     `commerce_create_channel_order` writes the order header directly and
  //     emits `channel.order.ingested`, so no draft event ever exists.
  //   - checkout-recovery: minted from an expired-checkout recovery token, which
  //     only the checkout-expiry path can create.
  //   - checkout-expired and payment-failed: both key off a one-time order
  //     reaching status `expired`/`failed`, and the ONLY writer of those statuses
  //     for a one-time order is `commerce_payment_apply_result`. The ingest saga
  //     calls `applySucceeded` and nothing else — the marketplace collected the
  //     money before the order existed here, so there is no decline or session to
  //     expire. Nothing sweeps a stale `draft` order to `expired` either.
  // This is an argument about the CURRENT ingest path. A later wave that gives a
  // channel order a decline or expiry rail must revisit this list, not assume it.
  //
  // `commerce.order.canceled` is absent from this enumeration because its email
  // handler (outboxOrderCanceledEmailHandler.ts) is registered by NOTHING — the
  // only claimant of that event type is the accounting reversal handler, which
  // arrives through `extraHandlers` and must keep running for a channel order.
  // Wrapping a handler this registry does not compose would be theatre; if that
  // email is ever wired up, it belongs in the wrapped set.
  const suppress = (handler: OutboxHandler): OutboxHandler =>
    suppressForChannel(handler, deps.transactionalEmail?.buyerCommsPolicyReader);
  const handlers: OutboxHandler[] = [
    ...(deps.transactionalEmail
      ? [
          createOutboxOrderDraftEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            lifecyclePort: deps.transactionalEmail.lifecyclePort,
          }),
          createOutboxCheckoutRecoveryEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            lifecyclePort: deps.transactionalEmail.lifecyclePort,
          }),
          suppress(createOutboxOrderPaidEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            linesPort: deps.transactionalEmail.orderPaidLinesPort,
            describeParcel: deps.transactionalEmail.orderPaidParcelNote,
          })),
          createOutboxPaymentFailedEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            lifecyclePort: deps.transactionalEmail.lifecyclePort,
          }),
          createOutboxCheckoutExpiredEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            lifecyclePort: deps.transactionalEmail.lifecyclePort,
          }),
          suppress(createOutboxOrderRefundedEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
          })),
          suppress(createOutboxShipmentDispatchedEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
          })),
          suppress(createOutboxShipmentDeliveredEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
            providerKindReader: deps.transactionalEmail.deliveredProviderKindReader,
          })),
          suppress(createOutboxShipmentExceptionEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
          })),
          suppress(createOutboxReturnApprovedEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
          })),
          suppress(createOutboxReturnRejectedEmailHandler({
            runtime: deps.transactionalEmail.runtime,
            emailPort: deps.transactionalEmail.emailPort,
            recipientPort: deps.transactionalEmail.recipientPort,
          })),
        ]
      : []),
    ...(deps.fulfillmentEnabled && deps.fulfillmentPort
      ? [
          createOutboxOrderPaidFulfillmentHandler({
            fulfillmentPort: deps.fulfillmentPort,
            riskPort: deps.riskPort,
            isRiskEnabled: () => deps.riskEnabled === true,
          }),
        ]
      : []),
    ...(deps.extraHandlers ?? []),
  ];
  const registry = deps.uniqueRegistry(handlers);
  const expected = deps.expectedDescriptors?.() ?? composeOutboxHandlerDescriptors([
    ...describeCoreOutboxHandlers({
      transactionalEmail: Boolean(deps.transactionalEmail),
      fulfillmentEnabled: deps.fulfillmentEnabled && Boolean(deps.fulfillmentPort),
    }),
    ...(deps.extraHandlers ?? []).map(({ eventType, timeoutMs }) => ({ eventType, timeoutMs })),
  ]);
  assertOutboxRegistryDescriptors(registry, expected);
  return registry;
}
