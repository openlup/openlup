import type { Pool } from "pg";

import type { CommunicationControlPlanePort } from "../../../src/domains/communications/ports.js";
import type { CapturedTransactionalDeliveryPort } from "../../../src/domains/communications/transactionalDeliveryPort.js";
import { createCapturedTransactionalDelivery } from "../captured/transactionalDelivery.js";
import {
  createCommunicationsControlPlanePort,
  isCommunicationsOperatorActive,
  settleCommunicationsControlPlaneSend,
} from "../communicationsControlPlane.js";
import {
  createPostgresCommunicationsControlPlaneTransactionLane,
  type PostgresDataGatewayEnv,
} from "./dataGateway.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

export type PostgresCommunicationsControlPlanePort = CommunicationControlPlanePort & {
  isOperatorActive(principalId: string): Promise<boolean>;
  close(): Promise<void>;
};

type Options = {
  operatorId: string;
  capturedFactory?: () => CapturedTransactionalDeliveryPort;
  poolFactory?: (env: PostgresDataGatewayEnv) => Pool | Promise<Pool>;
};

/** Direct public binding; every operation owns exactly one role-free transaction. */
export function createPostgresCommunicationsControlPlanePort(
  env: PostgresDataGatewayEnv,
  options: Options,
): PostgresCommunicationsControlPlanePort {
  const operatorId = options.operatorId.trim();
  if (!env.connectionString.trim()) throw new Error("communications_database_url_required");
  if (!operatorId) throw new Error("communications_operator_id_required");
  const lane = createPostgresCommunicationsControlPlaneTransactionLane(env, {
    ...(options.poolFactory ? { poolFactory: options.poolFactory } : {}),
  });
  const capturedFactory = options.capturedFactory ?? createCapturedTransactionalDelivery;
  const withPort = <T>(work: (port: CommunicationControlPlanePort) => Promise<T>) =>
    lane.run((client) => work(createCommunicationsControlPlanePort(client as PgQueryExecutor, {
      operatorId,
      capturedDelivery: capturedFactory(),
    })));

  return {
    async sendEmail(request) {
      const settled = await lane.run((client) => settleCommunicationsControlPlaneSend(
        client as PgQueryExecutor,
        { operatorId, capturedDelivery: capturedFactory() },
        request,
      ));
      if (settled.ok === false) throw settled.error;
      return settled.response;
    },
    getDeliveryOperations: (request) => withPort((port) => port.getDeliveryOperations(request)),
    getDeliveryOperationEvents: (request) => withPort((port) => port.getDeliveryOperationEvents(request)),
    mutateDeliveryControl: (request) => withPort((port) => port.mutateDeliveryControl(request)),
    isOperatorActive: (principalId) => lane.run((client) =>
      isCommunicationsOperatorActive(client as PgQueryExecutor, principalId)),
    close: lane.close,
  };
}
