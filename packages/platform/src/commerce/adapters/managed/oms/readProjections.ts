import type { OmsManagedReadProjections } from "../../../contracts/omsTypes.js";
export type { OmsManagedReadProjections } from "../../../contracts/omsTypes.js";
import type { OmsReadModelProjections } from "../../../model/omsReadModelProjections.js";
import type { OmsOrderDetail } from "../../../oms/omsContracts.js";
import type { OmsOrderRow, OmsOrderItemRow, OmsPaymentIntentRow, OmsAccountingInvoiceRow } from "../../../model/omsReadModelRows.js";
import type { OmsFulfillmentOperationRow, OmsFulfillmentOrderRow, OmsProviderDispatchRefRow, OmsProviderStatusEvidenceRow, OmsProviderAttemptRow, OmsReleasedProviderExceptionHoldRow } from "../../../model/omsFulfillmentSummary.js";
import type { OmsInboundProviderEventRow, OmsFulfillmentProviderStockCurrentRow } from "../../../model/omsFulfillmentDebug.js";
import type { CommerceOmsStore } from "./types.js";

export const emptyOmsManagedReadProjections = {
  readIdentity: async (): Promise<Record<string, Record<string, unknown>>> => ({}),
  mapInvoice: (value: unknown) => value as OmsAccountingInvoiceRow,
  readFulfillmentOperations: async () => [],
  readProviderDispatchRefs: async () => [],
  readProviderStatusEvidence: async () => [],
  readProviderAttempts: async () => [],
  readReleasedProviderExceptionHolds: async () => [],
  readProviderStockCurrent: async () => [],
  readInboundEvents: async () => [],
  buildHealth: (input: { order: OmsOrderRow }): OmsOrderDetail["fulfillmentHealth"] => ({ healthStatus: "ok", attentionReasons: [], oldestAgeSeconds: null, opaqueIds: { orderId: input.order.id, fulfillmentOrderId: null, outboxEventId: null, dispatchRefFulfillmentOrderId: null, latestEvidenceFulfillmentOrderId: null } }),
  buildHealthDigests: () => ({}),
};
