import { createOutboxShipmentDeliveredEmailHandler as createOutboxShipmentDeliveredEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort } from "./outboxOrderDraftEmailPorts.js";
import type { DeliveredEmailProviderKindReader } from "@openlup/platform/commerce/server";
export { outboxShipmentDeliveredEmailDescriptor, OUTBOX_SHIPMENT_DELIVERED_TEMPLATE_SLUG, type DeliveredEmailProviderKindReader } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxShipmentDeliveredEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  // When provided, suppress OUR delivered email for carrier-owned providers.
  providerKindReader?: DeliveredEmailProviderKindReader;
}) {
  return createOutboxShipmentDeliveredEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
