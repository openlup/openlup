import { createOutboxOrderPaidEmailHandler as createOutboxOrderPaidEmailHandlerCore } from "@openlup/platform/commerce/server";
import type { OrderRecipientPort, TransactionalEmailPort, OrderPaidLinesPort } from "./outboxOrderDraftEmailPorts.js";
import type { OrderPaidParcelNoteReader as NeutralParcelNoteReader } from "@openlup/platform/commerce/server";
import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
export type OrderPaidParcelNoteReader = NeutralParcelNoteReader<Locale>;
export { outboxOrderPaidEmailDescriptor, OUTBOX_ORDER_PAID_TEMPLATE_SLUG } from "@openlup/platform/commerce/server";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort, bindOrderPaidLinesPort } from "./commerceEmailBinding.js";

export function createOutboxOrderPaidEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  linesPort: OrderPaidLinesPort;
  describeParcel?: OrderPaidParcelNoteReader;
}) {
  return createOutboxOrderPaidEmailHandlerCore({ ...deps, runtime: commerceEmailRuntime,
    emailPort: bindTransactionalEmailPort(deps.emailPort), recipientPort: bindOrderRecipientPort(deps.recipientPort),
    linesPort: bindOrderPaidLinesPort(deps.linesPort),
  });
}
