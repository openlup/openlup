// Reference-application binding of the BFF dispatcher from @openlup/platform.
//
// Every mounted route reaches the ambient currency schema through its response or request
// contract, and dispatch is the one funnel they all pass through (the serverless entrypoint, its
// rewrite wrapper, the self-hosted server and the development plugin alike), so the settlement
// profile is resolved here before matching. Admin routes pass the admin preflight before their
// handler, and an unmatched path answers the BFF envelope's NOT_FOUND.

import { createBffDispatcher } from "@openlup/platform/bff";
import { preflightAdminBffRoute } from "./auth/adminAuthBinding.js";
import { bootstrapAmbientSettlementProfile } from "./settlementProfileBootstrap.js";
import { sendBffError } from "../_lib/bff/response.js";

export type { RouteEntry } from "@openlup/platform/bff";

export const dispatch = createBffDispatcher({
  env: () => process.env,
  beforeDispatch: () => bootstrapAmbientSettlementProfile(),
  preflight: preflightAdminBffRoute,
  notFound: (res, pathname) => {
    sendBffError(res, "NOT_FOUND", "BFF route not found", { details: { path: pathname } });
  },
});
