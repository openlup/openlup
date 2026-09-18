import type { Pool } from "pg";
import type { CustomerChallengeStore } from "../../domains/auth/ports.js";
import {
  createPostgresCustomerRecoveryTransactionLane,
  type PostgresDataGatewayEnv,
} from "./dataGateway.js";
import type { PgQueryExecutor } from "./queryBuilder.js";
import { customerCommunicationPreferencesResponseSchema } from "../../../src/domains/communications/customerPreferencesContracts.js";
import type { CustomerCommunicationPreferencesPort } from "../../domains/communications/customerCommunicationPreferencesHandler.js";

export type PostgresCustomerChallengeStore = CustomerChallengeStore & {
  close(): Promise<void>;
};

export function createPostgresCustomerChallengeStore(
  env: PostgresDataGatewayEnv,
  options: { poolFactory?: (env: PostgresDataGatewayEnv) => Pool | Promise<Pool> } = {},
): PostgresCustomerChallengeStore {
  const lane = createPostgresCustomerRecoveryTransactionLane(env, options);
  return {
    async issue(input) {
      return lane.run(async (executor) => {
        const { rows } = await (executor as PgQueryExecutor).query(
          "SELECT public.customer_identity_challenge_issue($1,$2,$3::timestamptz,now()) AS result",
          [input.email, input.tokenHash, input.expiresAt],
        );
        const result = rows[0]?.result;
        if (!result || typeof result !== "object") throw new Error("customer challenge issue response invalid");
        return { deliverable: (result as { deliverable?: unknown }).deliverable === true };
      });
    },
    async redeem(input) {
      return lane.run(async (executor) => {
        const { rows } = await (executor as PgQueryExecutor).query(
          "SELECT public.customer_identity_challenge_redeem($1,$2::timestamptz) AS result",
          [input.tokenHash, input.now],
        );
        const result = rows[0]?.result;
        if (result === null || result === undefined) return null;
        if (!result || typeof result !== "object") throw new Error("customer challenge redeem response invalid");
        const value = result as Record<string, unknown>;
        if (typeof value.principalId !== "string" || typeof value.email !== "string") {
          throw new Error("customer challenge redeem response invalid");
        }
        return { principalId: value.principalId, email: value.email };
      });
    },
    close: lane.close,
  };
}

type RpcClient = {
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

export function createPostgresCustomerCommunicationPreferencesPort(
  gateway: RpcClient,
): CustomerCommunicationPreferencesPort {
  return {
    async getPreferences() {
      const { data, error } = await gateway.rpc("customer_communication_preferences_as_actor");
      if (error) throw error;
      return data === null ? null : customerCommunicationPreferencesResponseSchema.parse(data);
    },
    async updatePreferences(_principalId, input) {
      const { data, error } = await gateway.rpc(
        "customer_communication_preferences_set_as_actor",
        { p_marketing_newsletter_consent: input.marketingNewsletterConsent },
      );
      if (error) throw error;
      return data === null ? null : customerCommunicationPreferencesResponseSchema.parse(data);
    },
  };
}
