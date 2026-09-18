import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createAddressCanonLocalitiesHandler } from "../../domains/address-canon/addressCanonLookupHandler.js";
import { createHiddenAddressCanonRoute } from "./shared.js";

const addressCanonLocalitiesHandler = createHiddenAddressCanonRoute((lookupPort) =>
  createAddressCanonLocalitiesHandler({ lookupPort }),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return addressCanonLocalitiesHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/address-canon/localities",
  domain: "address-canon",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_ADDRESS_CANON_LOOKUP_ENABLED"],
}, handler);
