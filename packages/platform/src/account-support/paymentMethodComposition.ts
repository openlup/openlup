import type { MethodSetupInput, MethodSetupPort, MethodSetupResult } from "./contracts/index.js";

/** M07 collection only; ready, replayed and unsupported remain the owner's result. */
export function createPaymentMethodComposition<Handoff>(port: MethodSetupPort<Handoff>): {
  execute(userId: string, request: MethodSetupInput): Promise<MethodSetupResult<Handoff>>;
} {
  return { execute(_userId, request) { return port.setupMethod(request); } };
}
