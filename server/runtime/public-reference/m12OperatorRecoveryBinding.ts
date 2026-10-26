import { createManagedOperatorAuthority, createOperatorRecovery, createPostgresOperatorAuthority,
  operatorAuthorityCapabilities, type OperatorAuthorityOptions, type OperatorRpcExecutor,
  type OperatorTransactionExecutor } from "@openlup/platform/account-support";
import type { OperatorAccountLinkIdentityPort, OperatorIdentityMovePort } from "@openlup/platform/account-support/contracts";

export type M12OperatorRecoveryOptions = { enabled?: boolean } & (
  | { graph: "managed"; rpc: OperatorRpcExecutor; options: OperatorAuthorityOptions;
      identity: () => OperatorIdentityMovePort; accountLink: OperatorAccountLinkIdentityPort }
  | { graph: "native"; transaction: OperatorTransactionExecutor; options: OperatorAuthorityOptions }
);
/** Inert reference selection. The host admits a human/admin/active seat before effects.
 * Recovery uses the runtime Web Crypto API; recovery-path policy stays host-owned. */
export function createM12OperatorRecoveryBinding(input: M12OperatorRecoveryOptions) {
  if (input.enabled !== true) return null;
  if (!input.options || typeof input.options.now !== "function" || typeof input.options.recoveryPath !== "function") {
    throw new Error("m12_operator_recovery_ports_required");
  }
  if (input.graph === "native") {
    if (typeof input.transaction?.run !== "function") throw new Error("m12_operator_recovery_ports_required");
    return { ...createOperatorRecovery({ graph: "native", authority: createPostgresOperatorAuthority(input.transaction, input.options) }),
      capabilities: operatorAuthorityCapabilities("native") };
  }
  if (typeof input.rpc?.rpc !== "function" || typeof input.identity !== "function"
      || typeof input.accountLink?.findSubject !== "function" || typeof input.accountLink?.resolveIdentityForEmail !== "function") {
    throw new Error("m12_operator_recovery_ports_required");
  }
  return { ...createOperatorRecovery({ graph: "managed", authority: createManagedOperatorAuthority(input.rpc, input.options),
    identity: input.identity, accountLink: input.accountLink }), capabilities: operatorAuthorityCapabilities("managed") };
}
