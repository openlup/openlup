import { createOutboxCheckoutRecoveryEmailHandler as createOutboxCheckoutRecoveryEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort, OrderPaymentLifecyclePort } from "./outboxOrderDraftEmailPorts.js";
export { outboxCheckoutRecoveryEmailDescriptor } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxCheckoutRecoveryEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}) {
  return createOutboxCheckoutRecoveryEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
