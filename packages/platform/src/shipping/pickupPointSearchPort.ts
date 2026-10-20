import type {
  PickupPointSearchRequest,
  PickupPointSearchResult,
} from "./contracts/index.js";

export interface PickupPointSearchPort {
  searchPickupPoints(request: PickupPointSearchRequest): Promise<PickupPointSearchResult[]>;
}
