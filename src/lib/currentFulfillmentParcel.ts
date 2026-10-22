// Core owns parcel precedence and attribution; retain the host import surface.
export {
  parcelSequenceNo,
  compareParcelPrecedence,
  currentParcel,
  currentParcelFor,
  currentParcelPerOrder,
  currentParcelFirst,
  belongsToParcel,
  rowsForParcel,
} from "@openlup/core/fulfillment";
export type { FulfillmentParcelRow, ParcelAttributedRow } from "@openlup/core/fulfillment";
