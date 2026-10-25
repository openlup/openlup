export { accountingRecoveryGuidance, sanitizeAccountingLastError } from "@openlup/platform/commerce";
export type { OmsAccountingRecoveryGuidance } from "@openlup/platform/commerce/contracts";
import { accountingSummary as summarize } from "@openlup/platform/commerce";
import type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow } from "./omsReadModelRows.js";
import { referenceOmsProjections,toNeutralInvoice,toReferenceAccounting } from "./omsReferenceBinding.js";
export function accountingSummary(invoice: OmsAccountingInvoiceRow | null, rows: OmsAccountingOutboxRow[]) { return toReferenceAccounting(summarize(toNeutralInvoice(invoice), rows, referenceOmsProjections)); }
