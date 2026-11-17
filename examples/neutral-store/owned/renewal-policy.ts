import type { createPostgresSubscriptionCommands, SubscriptionQueryExecutor } from '@openlup/platform/subscriptions';

export interface RenewalPolicyInput {
  /** The session holding population exclusion; never a request/user connection. */
  db: SubscriptionQueryExecutor;
  /** Native work has completed. Recheck durable evidence before making a decision. */
  result: unknown;
  createCommands: typeof createPostgresSubscriptionCommands;
  /** Lazy transaction on db. Bind commands to its callback connection without a nested commit. */
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
}
export type RenewalPolicy = (input: RenewalPolicyInput) => Promise<void>;

/** Application-owned post-renewal policy. The default adds no queries or business effects. */
export const renewalPolicy: RenewalPolicy = async () => {};
