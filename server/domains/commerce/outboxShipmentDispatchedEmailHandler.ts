import { carrierTrackingUrl } from "../../../src/domains/shipping/contracts.js";
import { createOutboxShipmentDispatchedEmailHandler as createOutboxShipmentDispatchedEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort } from "./outboxOrderDraftEmailPorts.js";
export { outboxShipmentDispatchedEmailDescriptor, OUTBOX_SHIPMENT_DISPATCHED_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxShipmentDispatchedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}) {
  return createOutboxShipmentDispatchedEmailHandlerCore({ ...deps, runtime: { ...commerceEmailRuntime, legacyTrackingUrl },
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}

export function legacyTrackingUrl(
  ref: { providerKind: string | null; carrierKind: string | null; trackingNumber: string },
  hasExplicitReferences: boolean,
): string | null {
  const direct = ref.providerKind === "dhl" || (!ref.providerKind && (ref.carrierKind ? ref.carrierKind === "dhl" : !hasExplicitReferences));
  return direct ? carrierTrackingUrl("dhl", ref.trackingNumber) : null;
}
