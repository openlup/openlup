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
