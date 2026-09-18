import {
  createBundleAdminWriteStore,
  type BundleWriteRoutineClient,
} from "../bundleAdminWriteStore.js";
import type { AdminBundleWritePort } from "../../domains/bundle/adminBundleWritePort.js";

/**
 * Managed-platform adapter for the bundle write port.
 *
 * The managed service client already exposes the one capability the port needs —
 * execute a named routine — so this adapter is the binding between that client
 * and the shared marshalling, and nothing else. The routines are the security
 * boundary (explicit actor, re-derived actor kind, atomic audit row, idempotency
 * short-circuit, dry-run rollback); no rule is re-implemented here.
 */
export function createManagedBundleAdminWriteStore(
  client: BundleWriteRoutineClient,
): AdminBundleWritePort {
  return createBundleAdminWriteStore(client);
}
