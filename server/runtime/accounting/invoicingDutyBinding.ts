import { Pool } from "pg";
import { createIndependentInvoiceDutyBinding, createPostgresInvoiceStore } from "@openlup/platform/invoicing";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

/** Explicit native-only collector. Each pool.query commits before the next phase;
 * never supply a client enlisted in a fulfillment or payment transaction.
 * No provider call or scheduler is installed by constructing this binding.
 */
export function createInvoicingDutyBinding(env: Record<string, string | undefined>) {
  if (resolveBundleId(env) !== "node-postgres" || !env.DATABASE_URL?.trim()) return null;
  const pool = new Pool({ connectionString: env.DATABASE_URL.trim(), max: 1 });
  pool.on?.("error", (error: Error) => {
    console.error(`[openlup/server:invoicing-duty] idle postgres error: ${error instanceof Error ? error.message : String(error)}`);
  });
  const store = createPostgresInvoiceStore(pool);
  return { ...createIndependentInvoiceDutyBinding({ store }), close: () => pool.end() };
}
