import type { SubscriptionCapabilities } from "./contracts/commands.js";

/** One host executor for a selected population. Construction never starts work. */
export function createSubscriptionServices<Result>(input: {
  enabled?: boolean;
  capabilities: SubscriptionCapabilities;
  readiness(): Promise<{ kind: "ready" } | { kind: "refused"; code: string }>;
  run(): Promise<Result>;
}) {
  async function readiness() {
    if (input.enabled !== true) return { kind: "refused", code: "disabled" } as const;
    return input.readiness();
  }
  return {
    capabilities: input.capabilities, readiness,
    async run() {
      const state = await readiness();
      return state.kind === "ready" ? input.run() : state;
    },
  };
}

export const NATIVE_SUBSCRIPTION_CAPABILITIES = Object.freeze({
  graph: "native",
  multiCyclePrepaid: Object.freeze({ supported: false, refusalCode: "multi_cycle_prepaid_unsupported" }),
  genericBundleCommands: Object.freeze({ supported: true }),
  commandBoundReceipts: Object.freeze({ supported: true }),
  preparedAttemptStore: Object.freeze({ supported: false, refusalCode: "native_prepared_attempt_store_unsupported" }),
  retryRecovery: "selected",
  // Native stock adapters exist; selection requires passing real-PG evidence.
  stockRecovery: "unavailable",
  deliveryAdmission: "required", executorCount: 1, defaultEnabled: false,
} as const satisfies import("./contracts/commands.js").SubscriptionCapabilities);
