/** Compatibility facade: one package owner for current-parcel precedence and attribution. */
export { parcelSequenceNo, compareParcelPrecedence, currentParcel, currentParcelFor, currentParcelPerOrder, currentParcelFirst, belongsToParcel, rowsForParcel } from '@openlup/platform/fulfillment';
// Preserve the host's existing structural type names; no runtime rule is duplicated.
export type FulfillmentParcelRow = { id?: unknown; order_id?: unknown; sequence_no?: unknown };
export type ParcelAttributedRow = { fulfillment_order_id?: unknown };
