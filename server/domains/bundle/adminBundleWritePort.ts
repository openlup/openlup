import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";

/**
 * Error carrying the SQLSTATE + message the write boundary raised, so the handler
 * maps it onto the BFF envelope (42501 -> FORBIDDEN, P0001 -> CONFLICT/rule,
 * P0002 -> NOT_FOUND). A thin alias of the generic kit `DomainRpcError` so
 * `mapRpcError` handles it uniformly.
 */
export class BundleRpcError extends DomainRpcError {
  constructor(sqlstate: string | undefined, message: string) {
    super(sqlstate, message);
    this.name = "BundleRpcError";
  }
}
export type { BundleWriteResult, BundleCompositionConstraintEnvelope, AdminBundleWritePort } from "@openlup/platform/catalog";
