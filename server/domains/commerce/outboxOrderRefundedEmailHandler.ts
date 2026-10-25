import { createOutboxOrderRefundedEmailHandler as createOutboxOrderRefundedEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort } from "./outboxOrderDraftEmailPorts.js";
export { outboxOrderRefundedEmailDescriptor, OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxOrderRefundedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}) {
  return createOutboxOrderRefundedEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
