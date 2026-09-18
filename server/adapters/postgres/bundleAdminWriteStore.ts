import {
  createPostgresBundleAdminWriteTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "./dataGateway.js";
import {
  createBundleAdminWriteStore,
  type BundleWriteRoutineClient,
} from "../bundleAdminWriteStore.js";
import type { AdminBundleWritePort } from "../../domains/bundle/adminBundleWritePort.js";

/**
 * Direct-Postgres adapter for the bundle write port: one role-free transaction per
 * operation, calling the same named routines under the same argument names as its
 * managed twin. It is a real adapter, not a placeholder — it opens a pooled
 * connection, runs the routine inside BEGIN/COMMIT, and surfaces the routine's own
 * SQLSTATE through the shared marshalling, so the port contract cannot tell the two
 * chains apart.
 *
 * The platform manifest creates no service role, so this lane never changes the
 * connection role; the adopter's own database user is the caller, exactly as the
 * outbox and delivery-receipt adapters do it.
 */
export interface PostgresBundleAdminWriteStore extends AdminBundleWritePort {
  close(): Promise<void>;
}

export function createPostgresBundleAdminWriteStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresBundleAdminWriteStore {
  const transactions = createPostgresBundleAdminWriteTransactionLane(env, options);

  // One transaction per routine call: the lane acquires a client, BEGINs, runs the
  // call and COMMITs (or ROLLBACKs and rethrows). A dry run relies on the routine's
  // own rollback, exactly as the managed chain does, so the two behave identically.
  const client: BundleWriteRoutineClient = {
    rpc(name, args) {
      return transactions.run((gateway) =>
        Promise.resolve((gateway as BundleWriteRoutineClient).rpc(name, args)),
      );
    },
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              return transactions.run((gateway) =>
                Promise.resolve(
                  (gateway as BundleWriteRoutineClient).from(table).select(columns).eq(column, value),
                ),
              );
            },
          };
        },
      };
    },
  };

  return {
    ...createBundleAdminWriteStore(client),
    close: () => transactions.close(),
  };
}
