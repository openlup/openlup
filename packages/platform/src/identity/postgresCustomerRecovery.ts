import type { CustomerChallengeStore } from "./ports.js";
import {
  createPostgresRoleFreeTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "../data/index.js";
import type { PgQueryExecutor } from "../data/index.js";

export type PostgresCustomerChallengeStore = CustomerChallengeStore & {
  close(): Promise<void>;
};

export function createPostgresCustomerChallengeStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresCustomerChallengeStore {
  const lane = createPostgresRoleFreeTransactionLane(env, options);
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
