import type { HttpResponse } from "../http/index.js";
import type { AdminShippingRateResponse, AdminSetShippingRateRequest, AdminSetShippingRateResponse } from "./contracts/shippingRate.js";

/** Only the incumbent flat-rate reads, writes and best-effort audit. */
export interface ShippingRateDataPort {
  getShippingFlatMinor(): Promise<number>;
  setShippingFlatMinor(minor: number): Promise<void>;
  recordPromotionAudit(entry: {
    actorId: string;
    actorEmail: string | null;
    action: "shipping_rate_change";
    promotionId: string;
    newValue: Record<string, unknown>;
  }): Promise<void>;
}
type Authorization =
  | { ok: true; userId: string; role: "admin" | "distributor"; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string; identityCode?: string };
export interface AdminShippingRateHandlerDeps {
  dataPort: ShippingRateDataPort;
  authorizeAdmin: () => Promise<Authorization>;
  /** The host retains its authorization/error response context. */
  resolveAdmin: (authorizeAdmin: () => Promise<Authorization>, res: HttpResponse) => Promise<{ userId: string } | null>;
}
type Schema<T> = {
  safeParse(input: unknown):
    | { success: true; data: T }
    | { success: false; error: { flatten(): unknown } };
};
/** Required host validation; there is no default amount policy. */
export interface ShippingRateHandlerSchemas {
  contractVersion: AdminShippingRateResponse["contractVersion"];
  adminShippingRateResponseSchema: Schema<AdminShippingRateResponse>;
  adminSetShippingRateRequestSchema: Schema<AdminSetShippingRateRequest>;
  adminSetShippingRateResponseSchema: Schema<AdminSetShippingRateResponse>;
}
