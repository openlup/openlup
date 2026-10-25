export type { OmsAccountingInvoiceRow,OmsAccountingOutboxRow,OmsAddressRow,OmsCommunicationDeliveryRow,OmsCustomerRow,OmsHoldRow,OmsInventoryReservationRow,OmsOperationRow,OmsOrderItemRow,OmsOrderRow,OmsOrderRowCore,OmsOrderRowCoreInput,OmsPaymentAttemptRow,OmsPaymentIntentRow,OmsPaymentTransitionRow } from "../contracts/omsTypes.js";

// Every status union below is read back out of the contract the row feeds, so a
// vocabulary can only be widened in one place. The rows are DB shapes, not
// contract shapes, so the derivation is by indexed access rather than by
// re-importing the zod schemas - this file stays type-only and carries no
// runtime import.
