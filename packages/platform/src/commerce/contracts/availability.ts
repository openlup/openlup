export type CommerceOfferAvailabilityStatus = "available" | "low_stock" | "out_of_stock" | "unknown";
export interface CommerceOfferAvailabilityRequestItem {
  sku: string;
  productSlug: string;
  variantId: string;
  requestedQuantity: number;
  checkoutMode: "one_time" | "subscription";
}
export interface CommerceOfferAvailability {
  sku: string;
  productSlug: string;
  variantId: string;
  status: CommerceOfferAvailabilityStatus;
  visibleInConfigurator: boolean;
  sellableNow: number | null;
  reasonCode: string;
  source: string;
}
export interface CommerceOfferAvailabilityPort {
  getAvailability(input: { items: readonly CommerceOfferAvailabilityRequestItem[] }): Promise<CommerceOfferAvailability[]>;
}
