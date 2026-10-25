import type { CommerceOmsReadPort } from "../../../src/domains/commerce/omsPorts.js";
import type { OmsAdminAuthResult } from "@openlup/platform/commerce/server";
import * as oms from "@openlup/platform/commerce/server";
import { adminCommerceOrderDetailResponseSchema,adminCommerceOrdersListRequestSchema,adminCommerceOrdersListResponseSchema } from "../../../src/domains/commerce/omsContracts.js";
import { applyOmsAgentCustomerReadGate,type OmsAgentReadGovernance } from "../../_lib/admin-domain/customerReadGovernance.js";
import { sendBffError,sendBffSuccess,sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest,VercelResponse } from "../../_lib/types/vercel.js";
export type { OmsAdminAuthResult as AdminAuthResult } from "@openlup/platform/commerce/server";
export interface BaseDeps { authorizeAdmin(req: VercelRequest): Promise<OmsAdminAuthResult> }
export function createAdminCommerceOrdersListHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrdersListHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate" | "omsPort"> & BaseDeps & { omsPort: Pick<CommerceOmsReadPort, "listOrders">; governance?: OmsAgentReadGovernance }) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrdersListHandler({ ...deps, omsPort: deps.omsPort as Parameters<typeof oms.createAdminCommerceOrdersListHandler<VercelResponse>>[0]["omsPort"], authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, listRequestSchema: adminCommerceOrdersListRequestSchema, listResponseSchema: adminCommerceOrdersListResponseSchema, detailResponseSchema: adminCommerceOrderDetailResponseSchema, readGate: input => applyOmsAgentCustomerReadGate({ ...input, governance: deps.governance, res, route: input.view === "list" ? "/api/bff/admin/commerce/orders" : "/api/bff/admin/commerce/orders/detail" }) })(req, res);
}
export function createAdminCommerceOrderDetailHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderDetailHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate" | "omsPort"> & BaseDeps & { omsPort: Pick<CommerceOmsReadPort, "getOrderDetail">; governance?: OmsAgentReadGovernance }) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderDetailHandler({ ...deps, omsPort: deps.omsPort as Parameters<typeof oms.createAdminCommerceOrderDetailHandler<VercelResponse>>[0]["omsPort"], authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed }, listRequestSchema: adminCommerceOrdersListRequestSchema, listResponseSchema: adminCommerceOrdersListResponseSchema, detailResponseSchema: adminCommerceOrderDetailResponseSchema, readGate: input => applyOmsAgentCustomerReadGate({ ...input, governance: deps.governance, res, route: input.view === "list" ? "/api/bff/admin/commerce/orders" : "/api/bff/admin/commerce/orders/detail" }) })(req, res);
}
export function createAdminCommerceOrderHoldHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderHoldHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderHoldHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
export function createAdminCommerceOrderReleaseHoldHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderReleaseHoldHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderReleaseHoldHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
export function createAdminCommerceOrderNoteHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderNoteHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderNoteHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
export function createAdminCommerceOrderUpdateShippingAddressHandler(deps: Omit<Parameters<typeof oms.createAdminCommerceOrderUpdateShippingAddressHandler<VercelResponse>>[0], "authorizeAdmin" | "respond" | "readGate"> & BaseDeps) {
 return (req: VercelRequest, res: VercelResponse) => oms.createAdminCommerceOrderUpdateShippingAddressHandler({ ...deps, authorizeAdmin: () => deps.authorizeAdmin(req), respond: { sendBffError, sendBffSuccess, sendMethodNotAllowed } })(req, res);
}
export function authorize(req: VercelRequest, res: VercelResponse, authorizeAdmin: BaseDeps["authorizeAdmin"]) { return oms.authorize(req, res, () => authorizeAdmin(req), { sendBffError, sendBffSuccess, sendMethodNotAllowed }); }
