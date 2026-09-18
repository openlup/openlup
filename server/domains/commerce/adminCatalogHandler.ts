import {
  CATALOG_ACTIVATION_FLAG,
  CATALOG_MUTATION_FLAG,
} from "../../../src/domains/commerce/catalogSpec.js";
import { sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { resolveAdmin, type AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { AdminCatalogDataPort } from "./adminCatalogDataPort.js";

/**
 * @agent-domain-reference
 * W3c legacy mutation fence. Admin read routes and authentication remain in
 * place, but every legacy catalog mutation terminates after authentication and
 * before a data port or RPC can be reached.
 */

/** Back-compat: the flag names this module historically exported. */
export const CATALOG_MUTATIONS_FLAG = CATALOG_MUTATION_FLAG;
export { CATALOG_ACTIVATION_FLAG };

const LEGACY_CATALOG_MUTATION_FENCE_REASON = "legacy_catalog_mutation_fenced";
const LEGACY_CATALOG_MUTATION_FENCE_MESSAGE = "Legacy catalog mutation is fenced";

export interface AdminCatalogHandlerDeps {
  dataPort: AdminCatalogDataPort;
  authorizeAdmin: AuthorizeAdmin;
}

export function createLegacyCatalogMutationFenceHandler(authorizeAdmin: AuthorizeAdmin) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, ["POST"]);
      return;
    }

    const authz = await resolveAdmin(authorizeAdmin, res);
    if (!authz) return;

    sendBffError(res, "FORBIDDEN", LEGACY_CATALOG_MUTATION_FENCE_MESSAGE, {
      details: { reason: LEGACY_CATALOG_MUTATION_FENCE_REASON },
    });
  };
}

export function createAdminCatalogCreateDraftHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogUpdateDraftHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogSetPriceHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogArchiveHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogActivateHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogArchiveProductHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogRestoreHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

export function createAdminCatalogCloneDraftHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}

/** Deactivate is a legacy lifecycle mutation and shares the same W3c fence. */
export function createAdminCatalogDeactivateHandler(deps: AdminCatalogHandlerDeps) {
  return createLegacyCatalogMutationFenceHandler(deps.authorizeAdmin);
}
