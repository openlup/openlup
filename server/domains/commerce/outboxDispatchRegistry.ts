import type { Locale } from "../../../src/lib/i18n/resolveLocale.js";
import { legacyTrackingUrl } from "./outboxShipmentDispatchedEmailHandler.js";
import { uniqueRegistry } from "@openlup/outbox";
import { createOutboxDispatchRegistry as createRegistry } from "@openlup/platform/commerce/server";
import type { TransactionalEmailRegistryDeps as NeutralEmailDeps } from "@openlup/platform/commerce/server";
import type { TransactionalEmailPort, OrderRecipientPort, OrderPaidLinesPort } from "./outboxOrderDraftEmailPorts.js";
import { commerceEmailRuntime, bindOrderRecipientPort, bindTransactionalEmailPort, bindOrderPaidLinesPort } from "./commerceEmailBinding.js";
export { describeCoreOutboxHandlers, type OrderBuyerCommsPolicyReader } from "@openlup/platform/commerce/server";
export { claimAllowlist } from "@openlup/outbox";

type TransactionalEmailRegistryDeps = Omit<NeutralEmailDeps<Locale>, "runtime" | "emailPort" | "recipientPort" | "orderPaidLinesPort"> & {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  orderPaidLinesPort: OrderPaidLinesPort;
};
export function createOutboxDispatchRegistry(deps: Omit<Parameters<typeof createRegistry<Locale>>[0], "transactionalEmail" | "uniqueRegistry"> & {
  transactionalEmail?: TransactionalEmailRegistryDeps;
}) {
  return createRegistry({ ...deps, uniqueRegistry, transactionalEmail: deps.transactionalEmail ? { ...deps.transactionalEmail,
    runtime: { ...commerceEmailRuntime, legacyTrackingUrl }, emailPort: bindTransactionalEmailPort(deps.transactionalEmail.emailPort),
    recipientPort: bindOrderRecipientPort(deps.transactionalEmail.recipientPort),
    orderPaidLinesPort: bindOrderPaidLinesPort(deps.transactionalEmail.orderPaidLinesPort),
  } : undefined });
}
