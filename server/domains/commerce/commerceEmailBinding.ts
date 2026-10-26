import type { CommerceEmailRuntime } from "@openlup/platform/commerce/server";
import type { TransactionalEmailPort as NeutralEmailPort, OrderRecipientPort as NeutralRecipientPort,
  OrderPaidLinesPort as NeutralLinesPort } from "@openlup/platform/commerce";
import type { TransactionalEmailPort, OrderRecipientPort, OrderPaidLinesPort } from "./outboxOrderDraftEmailPorts.js";
import type { OrderPaidPricePresentation } from "./outboxOrderDraftEmailPorts.js";
import { mapResendOutcome } from "../../shared/mapResendOutcome.js";
import { parseOutboxPayload } from "../../shared/parseOutboxPayload.js";
import { createTransactionalEmailHandler } from "../../shared/transactionalEmailHandler.js";
import { resolveLocale, type Locale } from "../../../src/lib/i18n/resolveLocale.js";
import { providerOwnsDeliveredNotification } from "../../../src/domains/fulfillment/contracts.js";
import { carrierTrackingUrl, normalizeCarrierKind } from "../../../src/domains/shipping/contracts.js";
import { formatMoney, genericItemLabel } from "./orderEmailLines.js";
import { totalsFromFirstSubscription } from "./orderPaidEmailPresentation.js";

export const commerceEmailRuntime: Omit<CommerceEmailRuntime<Locale>, "legacyTrackingUrl"> = {
  parseOutboxPayload, resolveLocale, formatMoney, genericItemLabel, carrierTrackingUrl, normalizeCarrierKind,
  providerOwnsDeliveredNotification,
  mapSendOutcome: ({ messageId, ...outcome }) => mapResendOutcome({ ...outcome, resendId: messageId }),
  createTransactionalEmailHandler: (spec) => createTransactionalEmailHandler({ ...spec,
    send: async (ctx) => { const { messageId, ...outcome } = await spec.send(ctx); return { ...outcome, resendId: messageId }; },
  }),
  presentPaidOrder: (data) => data.presentation ? totalsFromFirstSubscription({ currency: data.currency,
    firstSubscriptionPricePresentation: data.presentation as OrderPaidPricePresentation }) : null,
};

export function bindOrderRecipientPort(port: OrderRecipientPort): NeutralRecipientPort {
  return { resolve: async (id, signal) => {
    const recipient = await port.resolve(id, signal);
    if (!recipient) return null;
    const { petName, ...rest } = recipient;
    return { ...rest, contextName: petName };
  } };
}
export function bindOrderPaidLinesPort(port: OrderPaidLinesPort): NeutralLinesPort {
  return { read: async (id, signal) => {
    const data = await port.read(id, signal);
    if (!data) return null;
    const { firstSubscriptionPricePresentation, ...rest } = data;
    return { ...rest, presentation: firstSubscriptionPricePresentation };
  } };
}
export function bindTransactionalEmailPort(port: TransactionalEmailPort): NeutralEmailPort<Locale> {
  const outcome = (result: Awaited<ReturnType<TransactionalEmailPort["sendOrderConfirmation"]>>) => {
    const { resendId, ...rest } = result;
    return { ...rest, messageId: resendId };
  };
  return {
    findExistingSend: (slug, id) => port.findExistingSend(slug, id),
    sendReturnApprovedNotice: async (input) => outcome(await port.sendReturnApprovedNotice(input)),
    sendReturnRejectedNotice: async (input) => outcome(await port.sendReturnRejectedNotice(input)),
    sendOrderConfirmation: async ({ contextName, ...input }) => outcome(await port.sendOrderConfirmation({ ...input, petName: contextName })),
    sendCheckoutRecovery: async ({ contextName, ...input }) => outcome(await port.sendCheckoutRecovery({ ...input, petName: contextName })),
    sendOrderPaidConfirmation: async ({ contextName, ...input }) => outcome(await port.sendOrderPaidConfirmation({ ...input, petName: contextName })),
    sendPaymentFailedNotice: async (input) => outcome(await port.sendPaymentFailedNotice(input)),
    sendCheckoutExpiredNotice: async (input) => outcome(await port.sendCheckoutExpiredNotice(input)),
    sendOrderCanceledNotice: async (input) => outcome(await port.sendOrderCanceledNotice(input)),
    sendOrderRefundedNotice: async (input) => outcome(await port.sendOrderRefundedNotice(input)),
    sendShipmentDispatchedNotice: async ({ contextName, ...input }) => outcome(await port.sendShipmentDispatchedNotice({ ...input, petName: contextName })),
    sendShipmentDeliveredNotice: async ({ contextName, ...input }) => outcome(await port.sendShipmentDeliveredNotice({ ...input, petName: contextName })),
    sendShipmentExceptionNotice: async (input) => outcome(await port.sendShipmentExceptionNotice(input)),
  };
}
