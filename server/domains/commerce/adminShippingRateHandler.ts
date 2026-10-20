import {
  createAdminShippingRateHandler as createHandler,
  type AdminShippingRateHandlerDeps as ShippingDeps,
  type ShippingRateDataPort,
  type ShippingRateHandlerSchemas,
} from "@openlup/platform/shipping";
import { bffResponder } from "../../_lib/bff/response.js";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  adminSetShippingRateRequestSchema,
  adminSetShippingRateResponseSchema,
  adminShippingRateResponseSchema,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";
import { resolveAdmin, type AuthorizeCommerceAdmin } from "./adminPromotionsHandler.js";

export interface AdminShippingRateHandlerDeps {
  dataPort: ShippingRateDataPort;
  authorizeAdmin: AuthorizeCommerceAdmin;
}
const schemas: ShippingRateHandlerSchemas = {
  contractVersion: COMMERCE_CONTRACT_VERSION,
  adminSetShippingRateRequestSchema, adminSetShippingRateResponseSchema, adminShippingRateResponseSchema,
};
export function createAdminShippingRateHandler(deps: AdminShippingRateHandlerDeps) {
  const bound: ShippingDeps = { ...deps, resolveAdmin };
  return createHandler(bound, schemas, bffResponder);
}
