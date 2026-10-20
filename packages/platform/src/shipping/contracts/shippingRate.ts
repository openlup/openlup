/** Browser DTOs for the incumbent flat-rate administration API. */
export interface AdminShippingRateResponse {
  contractVersion: "commerce.v0";
  shippingFlatMinor: number;
}
export interface AdminSetShippingRateRequest { shippingFlatMinor: number }
export interface AdminSetShippingRateResponse extends AdminShippingRateResponse { updated: true }
