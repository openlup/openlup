import { createOutboxOrderDraftEmailHandler as createOutboxOrderDraftEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort, OrderPaymentLifecyclePort } from "./outboxOrderDraftEmailPorts.js";
export { outboxOrderDraftEmailDescriptor, OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxOrderDraftEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}) {
  return createOutboxOrderDraftEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
