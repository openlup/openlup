import {
  defaultOfferAvailability,
} from "../../../src/domains/commerce/offerAvailability.js";
import type {
  CommerceOfferAvailabilityPort,
} from "../../../src/domains/commerce/ports.js";

export function createStaticOfferAvailabilityPort(): CommerceOfferAvailabilityPort {
  return {
    async getAvailability({ items }) {
      return items.map((item) => defaultOfferAvailability(item));
    },
  };
}
