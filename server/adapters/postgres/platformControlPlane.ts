import type { Pool } from "pg";

import type { PlatformControlPlanePort } from "../../../src/domains/platform/ports.js";
import {
  createPlatformControlPlanePort,
  isPlatformControlOperatorActive,
} from "../platformControlPlane.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import type { PostgresDataGatewayEnv } from "./dataGateway.js";
import { createPostgresPlatformControlPlaneTransactionLane } from "./dataGateway.js";

export type PostgresPlatformControlPlanePort = PlatformControlPlanePort & {
  isOperatorActive(principalId: string): Promise<boolean>;
  close(): Promise<void>;
};

export function createPostgresPlatformControlPlanePort(
  env: PostgresDataGatewayEnv,
  options: { operatorId: string; poolFactory?: (env: PostgresDataGatewayEnv) => Pool | Promise<Pool> },
): PostgresPlatformControlPlanePort {
  const operatorId = options.operatorId.trim();
  if (!env.connectionString.trim()) throw new Error("platform_control_database_url_required");
  if (!operatorId) throw new Error("platform_control_operator_id_required");
  const lane = createPostgresPlatformControlPlaneTransactionLane(env, {
    ...(options.poolFactory ? { poolFactory: options.poolFactory } : {}),
  });
  const withPort = <T>(work: (port: PlatformControlPlanePort) => Promise<T>) =>
    lane.run((client) => work(createPlatformControlPlanePort(client as PgQueryExecutor, operatorId)));
  return {
    readControlPlane: (request) => withPort((port) => port.readControlPlane(request)),
    mutateControlPlane: (request) => withPort((port) => port.mutateControlPlane(request)),
    isOperatorActive: (principalId) => lane.run((client) =>
      isPlatformControlOperatorActive(client as PgQueryExecutor, principalId)),
    close: lane.close,
  };
}
