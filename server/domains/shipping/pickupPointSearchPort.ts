import type { PickupPointSearchPort as PlatformPickupPointSearchPort } from "@openlup/platform/shipping";
import type {
  PickupPointSearchRequest,
  PickupPointSearchResult,
} from "../../../src/domains/shipping/pickupPointSearchContracts.js";

// Carrier-agnostic "nearest pickup points" search. The BFF composition root maps
// each carrier kind to its source (InPost ShipX public API now; Orlen Paczka API
// once wired). Unsupported carriers resolve to an empty result, never an error.
export interface PickupPointSearchPort extends PlatformPickupPointSearchPort {
  searchPickupPoints(request: PickupPointSearchRequest): Promise<PickupPointSearchResult[]>;
}
