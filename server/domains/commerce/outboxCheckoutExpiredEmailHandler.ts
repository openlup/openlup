import { createOutboxCheckoutExpiredEmailHandler as createOutboxCheckoutExpiredEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort, OrderPaymentLifecyclePort } from "./outboxOrderDraftEmailPorts.js";
export { outboxCheckoutExpiredEmailDescriptor, OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxCheckoutExpiredEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}) {
  return createOutboxCheckoutExpiredEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
