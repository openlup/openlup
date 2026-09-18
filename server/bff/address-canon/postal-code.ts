import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createAddressCanonPostalCodeHandler } from "../../domains/address-canon/addressCanonLookupHandler.js";
import { createHiddenAddressCanonRoute } from "./shared.js";

const addressCanonPostalCodeHandler = createHiddenAddressCanonRoute((lookupPort) =>
  createAddressCanonPostalCodeHandler({ lookupPort }),
);

function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return addressCanonPostalCodeHandler(req, res);
}

export default withObservedRoute({
  route: "/api/bff/address-canon/postal-code",
  domain: "address-canon",
  surface: "hidden",
  risk: "read",
  featureFlags: ["COMMERCE_ADDRESS_CANON_LOOKUP_ENABLED"],
}, handler);
