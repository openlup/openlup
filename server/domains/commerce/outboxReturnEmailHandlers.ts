import { createOutboxReturnApprovedEmailHandler as createOutboxReturnApprovedEmailHandlerCore, createOutboxReturnRejectedEmailHandler as createOutboxReturnRejectedEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort } from "./outboxOrderDraftEmailPorts.js";
export { describeOutboxReturnEmail, outboxReturnApprovedEmailDescriptor, outboxReturnRejectedEmailDescriptor, OUTBOX_RETURN_APPROVED_TEMPLATE_SLUG, OUTBOX_RETURN_REJECTED_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort } from "./commerceEmailBinding.js";

export function createOutboxReturnApprovedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}) {
  return createOutboxReturnApprovedEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}

export function createOutboxReturnRejectedEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
}) {
  return createOutboxReturnRejectedEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
  });
}
