import type { AdminCommerceOrdersListRequest,AdminCommerceOrdersListResponse } from "../oms/omsContracts.js";
export interface OmsHandlerRequest { method?: string; query?: Record<string, unknown>; body?: unknown }
export interface OmsHandlerResponder<Response> {
  sendMethodNotAllowed(res: Response, methods: readonly string[]): void;
  sendBffSuccess(res: Response, data: unknown): void;
  sendBffError(res: Response, code: "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "INVALID_RESPONSE" | "NOT_FOUND" | "CONFLICT" | "UPSTREAM_UNAVAILABLE", message: string, options?: { details: unknown }): void;
}
export type OmsAdminAuthResult = { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string } | { ok: true; userId: string; isMachineActor?: boolean };
export interface OmsReadGate {
  blocked: boolean;
  audit(customerIds: string[]): Promise<void>;
  maskOrders<T extends { orders: AdminCommerceOrdersListResponse["orders"] }>(response: T): T;
}
export interface OmsHandlerDeps<Response> {
  authorizeAdmin(req: OmsHandlerRequest): Promise<OmsAdminAuthResult>;
  respond: OmsHandlerResponder<Response>;
  listRequestSchema?: { safeParse(value: unknown): { success: true; data: AdminCommerceOrdersListRequest } | { success: false; error: { flatten(): unknown } } };
  listResponseSchema?: { safeParse(value: unknown): { success: true; data: AdminCommerceOrdersListResponse } | { success: false } };
  detailResponseSchema?: { safeParse(value: unknown): { success: true; data: import("../oms/omsContracts.js").AdminCommerceOrderDetailResponse } | { success: false } };
  readGate?(input: { authorization: Extract<OmsAdminAuthResult, { ok: true }>; view: "list" | "detail"; query: Record<string, unknown> }): OmsReadGate;
}
export const unprojectedOmsReadGate: OmsReadGate = { blocked: false, audit: async () => {}, maskOrders: response => response };
