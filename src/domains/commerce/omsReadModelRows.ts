export type { OmsAccountingOutboxRow,OmsAddressRow,OmsCommunicationDeliveryRow,OmsCustomerRow,OmsHoldRow,OmsInventoryReservationRow,OmsOperationRow,OmsOrderItemRow,OmsPaymentAttemptRow,OmsPaymentIntentRow,OmsPaymentTransitionRow } from "@openlup/platform/commerce/contracts";
import type * as Neutral from "@openlup/platform/commerce/contracts";
import type { OmsOrderDetail } from "./omsContracts.js";
export interface OmsOrderRow extends Neutral.OmsOrderRow { pet_id?: string | null }
export interface OmsPetRow {
  id: string;
  name: string | null;
  pet_type: string | null;
  breed: string | null;
  age_label: string | null;
  weight_kg: number | string | null;
}
export interface OmsAccountingInvoiceRow extends Omit<Neutral.OmsAccountingInvoiceRow, "fiscal_status"> { ksef_status: string | null }
export interface OmsOrderRowCoreInput extends Omit<Neutral.OmsOrderRowCoreInput, "order" | "accountingInvoice"> { order: OmsOrderRow; accountingInvoice: OmsAccountingInvoiceRow | null }
export interface OmsOrderRowCore extends Omit<Neutral.OmsOrderRowCore, "accounting"> { accounting: OmsOrderDetail["accounting"] }
