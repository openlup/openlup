import type { CustomerChallengeStore } from "./ports.js";
import {
  createPostgresRoleFreeTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "../data/index.js";
import type { PgQueryExecutor } from "../data/index.js";

export type PostgresCustomerChallengeStore = CustomerChallengeStore & {
  close(): Promise<void>;
  pruneChallenges(input: { limit: number }): Promise<{ deleted: number }>;
};

export function createPostgresCustomerChallengeStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresCustomerChallengeStore {
  const lane = createPostgresRoleFreeTransactionLane(env, options);
  return {
    async issue(input) {
      return lane.run(async (executor) => {
        const db = executor as PgQueryExecutor;
        // EXCLUSIVE conflicts with erasure's EXCLUSIVE lock and stays held through the RPC.
        // Receipt reads use ACCESS SHARE, compatible with erasure's receipt-table lock.
        await db.query("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE");
        const erased = await db.query(`SELECT 1 FROM public.clients c JOIN public.identity_privacy_erasures e ON e.client_id = c.id OR e.principal_id = c.principal_id
          WHERE lower(c.email) = lower(btrim($1))`, [input.email]);
        if (erased.rows.length) return { deliverable: false };
        const { rows } = await db.query(
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
        const db = executor as PgQueryExecutor;
        // EXCLUSIVE conflicts with erasure's EXCLUSIVE lock and stays held through the RPC.
        // Receipt reads use ACCESS SHARE, compatible with erasure's receipt-table lock.
        await db.query("LOCK TABLE public.customer_identity_challenges IN EXCLUSIVE MODE");
        const erased = await db.query(`SELECT 1 FROM public.customer_identity_challenges c
          JOIN public.identity_privacy_erasures e ON e.client_id = c.client_id OR e.principal_id = c.principal_id WHERE c.token_hash = $1`, [input.tokenHash]);
        if (erased.rows.length) return null;
        const { rows } = await db.query(
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
    async pruneChallenges({ limit }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("customer_prune_limit_invalid");
      return lane.run(async executor => {
        const deleted = await (executor as PgQueryExecutor).query(`WITH batch AS (SELECT id FROM public.customer_identity_challenges
          WHERE expires_at < clock_timestamp() - interval '24 hours' ORDER BY expires_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
          DELETE FROM public.customer_identity_challenges c USING batch WHERE c.id = batch.id RETURNING c.id`, [limit]);
        return { deleted: deleted.rows.length };
      });
    },
    close: lane.close,
  };
}
