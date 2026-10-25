export { buildCurrentDeliveryContact, buildOmsDeliveryContactProjection, deliveryContactAddress } from "@openlup/platform/commerce";
import { buildOmsOrderRowCore as buildNeutral } from "@openlup/platform/commerce";
import type { OmsOrderRowCore,OmsOrderRowCoreInput } from "./omsReadModelRows.js";
import { referenceOmsProjections,toNeutralInvoice,toReferenceAccounting } from "./omsReferenceBinding.js";
export function buildOmsOrderRowCore(input: OmsOrderRowCoreInput): OmsOrderRowCore {
 const result = buildNeutral({ ...input, accountingInvoice: toNeutralInvoice(input.accountingInvoice), projections: referenceOmsProjections });
 return { ...result, accounting: toReferenceAccounting(result.accounting) };
}
