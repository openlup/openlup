import type {
  CommerceOfferAvailability,
  CommerceOfferAvailabilityRequestItem,
} from "./offerAvailabilityContracts.js";

export interface CommerceOfferAvailabilityPort {
  getAvailability(input: {
    items: readonly CommerceOfferAvailabilityRequestItem[];
  }): Promise<CommerceOfferAvailability[]>;
}
