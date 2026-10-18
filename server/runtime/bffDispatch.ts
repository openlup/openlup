// Reference-application binding of the BFF dispatcher from @openlup/platform.
//
// Every mounted route reaches the ambient currency schema through its response or request
// contract, and dispatch is the one funnel they all pass through (the serverless entrypoint, its
// rewrite wrapper, the self-hosted server and the development plugin alike), so the settlement
// profile is resolved here before matching. Admin authorization runs in preflight or the
// policy-wrapped direct route; an unmatched path answers the BFF envelope's NOT_FOUND.

import { createBffDispatcher } from "@openlup/platform/bff";
import { preflightAdminBffRoute } from "./auth/adminAuthBinding.js";
import { bootstrapAmbientSettlementProfile } from "./settlementProfileBootstrap.js";
import { sendBffError } from "../_lib/bff/response.js";

export type { RouteEntry } from "@openlup/platform/bff";

import { createOperatorSessionBinding } from "./auth/operatorSessionBinding.js";
import { privacyRoutes } from "./auth/privacyRoutes.js";
import { operatorRoutes } from "./auth/operatorRoutes.js";
const readEnvironment = () => process.env;
const dispatcher = createBffDispatcher({
  env: readEnvironment,
  beforeDispatch: () => bootstrapAmbientSettlementProfile(),
  // Direct privacy mounts run preflight after their observed deployment-policy boundary.
  preflight: (req, res, route) => privacyRoutes(readEnvironment()).some(entry => entry.route === route)
    || preflightAdminBffRoute(req, res, route),
  notFound: (res, pathname) => {
    sendBffError(res, "NOT_FOUND", "BFF route not found", { details: { path: pathname } });
  },
});

export function createReferenceBffDispatch(createSessionBinding = createOperatorSessionBinding): import("@openlup/platform/bff").BffDispatch {
  return (routes, req, res) => dispatcher([
    ...operatorRoutes(readEnvironment(), createSessionBinding, routes), ...privacyRoutes(readEnvironment()), ...routes,
  ], req, res);
}
export const dispatch = createReferenceBffDispatch();
