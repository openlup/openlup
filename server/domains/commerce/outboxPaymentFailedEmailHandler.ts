import { createOutboxPaymentFailedEmailHandler as createOutboxPaymentFailedEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort, OrderPaymentLifecyclePort } from "./outboxOrderDraftEmailPorts.js";
export { outboxPaymentFailedEmailDescriptor, OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxPaymentFailedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}) {
  return createOutboxPaymentFailedEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
