import { createOutboxShipmentExceptionEmailHandler as createOutboxShipmentExceptionEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort } from "./outboxOrderDraftEmailPorts.js";
export { outboxShipmentExceptionEmailDescriptor, OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxShipmentExceptionEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}) {
  return createOutboxShipmentExceptionEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
