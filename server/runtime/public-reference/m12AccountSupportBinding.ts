import { createAccountSupportBindings, createAccountSupportServices, type AccountSupportCapabilities,
  type AccountSupportOperations, type AccountSupportCallable, type AccountSupportBindingRefusal, type AccountSupportHostBindingRequired, type createOperatorRecovery, type OperatorRecoveryCommand,
  type OperatorRecoveryCommandEnvelope, type NativeOperatorSubscriptionResult } from "@openlup/platform/account-support";
import { createAccountSupportContribution } from "@openlup/platform/composition";
import type { Contribution, ReadinessReport, RequiredSchema } from "@openlup/core/readiness";
import type { OutboxHandlerRegistry } from "@openlup/platform/commerce";
import { m12AccountSupportSchema } from "./m12AccountSupportSchema.js";
import { SUPPORT_CUSTOMER_360_CONTRACT_VERSION } from "../../../src/domains/support/customer360Contracts.js";
import { OperatorSubscriptionAuthorityUnavailableError } from "../../domains/support/customerRecoveryCommand.js";

/** Host-built M11 selection. Keep the reference adapter graph outside this module. */
export type M12CommerceSelection<S extends Readonly<Record<string, AccountSupportCallable>> = Readonly<Record<string, AccountSupportCallable>>> = {
  services: S;
  schema: RequiredSchema;
  contributions: readonly Contribution[];
  ports: Readonly<Record<string, unknown>>;
  routes: Readonly<Record<string, unknown>>;
  triggers: Readonly<Record<string, unknown>>;
};

/** Map R4's authority result to the donor BFF response before registering one
 * shared service/port/route callable. R4 already preserves the donor ISO timestamp;
 * ownerReceipt stays on R4's server-side result, outside the strict browser DTO.
 */
export function createM12OperatorSubscriptionActionRoute(execute: ReturnType<typeof createOperatorRecovery>["execute"]) {
  return async (envelope: OperatorRecoveryCommandEnvelope<Extract<OperatorRecoveryCommand, { action: "apply_subscription_action" }>>) => {
    // This entrance selects only the subscription arm of R4's command dispatcher.
    const result = await execute(envelope) as NativeOperatorSubscriptionResult;
    if (result.outcome === "refused" && result.refusalCode === "operator_subscription_authority_unavailable") {
      throw new OperatorSubscriptionAuthorityUnavailableError();
    }
    const base = { contractVersion: SUPPORT_CUSTOMER_360_CONTRACT_VERSION,
      action: envelope.command.action, subscriptionAction: envelope.command.subscriptionAction,
      subscriptionId: envelope.command.subscriptionId };
    if ("refusalCode" in result) {
      return { ...base, outcome: result.outcome, refusalCode: result.refusalCode };
    }
    return { ...base, outcome: result.outcome, subscriptionStatus: result.subscriptionStatus,
      nextCycleAt: result.nextCycleAt, templateVersion: result.templateVersion,
      eventId: result.eventId, appliedBy: result.appliedBy };
  };
}

/** Inert recipe. Supply already authenticated R1-R4 handlers/facades, never two
 * dispatchers for one command. This factory mounts nothing and starts no workers.
 */
export function createM12AccountSupportReferenceBinding<O extends AccountSupportOperations, C extends AccountSupportOperations = AccountSupportOperations,
  S extends Readonly<Record<string, AccountSupportCallable>> = Readonly<Record<string, AccountSupportCallable>>>(input: {
  enabled?: boolean;
  graph: "managed" | "native";
  capabilities: AccountSupportCapabilities;
  operations: O;
  commerce?: C | null;
  /** Supply the already-built M11 result with matching enablement and readiness
   * over the complete account/M11/ATP schema. Its services are already guarded.
   */
  commerceOwner?: M12CommerceSelection<S>;
  /** Existing host registry; construction never dispatches its handlers. */
  commerceRegistry?: OutboxHandlerRegistry;
  ownerSchemas: readonly RequiredSchema[];
  requiredObjects: RequiredSchema["objects"];
  dependsOn: NonNullable<Contribution["manifest"]["module"]>["dependsOn"];
  routes?: Contribution["routes"];
  version: string;
  catalogue: { version: string; migration: string };
  readiness(schema: RequiredSchema): Promise<ReadinessReport>;
}) {
  const binding = createAccountSupportBindings(input);
  const schema = m12AccountSupportSchema({ catalogue: input.catalogue, owners: input.ownerSchemas, requiredObjects: input.requiredObjects, commerce: input.commerceOwner });
  async function readiness() {
    const report = await input.readiness(schema);
    return report.state === "ready" ? { kind: "ready" as const } : { kind: "refused" as const, code: `schema_${report.state}` as const };
  }
  const options = { enabled: input.enabled, capabilities: binding.capabilities, readiness };
  const guarded = createAccountSupportServices({ ...options, operations: binding.operations });
  const commerceOwner = input.commerceOwner ?? null;
  async function commerce<K extends keyof C & string>(...args: Parameters<typeof binding.commerce<K>>):
    Promise<Awaited<ReturnType<Extract<C[K], AccountSupportCallable>>> | AccountSupportHostBindingRequired | AccountSupportBindingRefusal> {
    if (options.enabled !== true) {
      const state = await guarded.readiness();
      if (state.kind === "refused") return state;
    }
    if (commerceOwner && Object.prototype.hasOwnProperty.call(commerceOwner.services, args[0])) {
      const execute = commerceOwner.services[args[0]] as (...values: Parameters<C[K] & AccountSupportCallable>) => Promise<Awaited<ReturnType<Extract<C[K], AccountSupportCallable>>> | AccountSupportBindingRefusal>;
      return execute(...args.slice(1) as Parameters<C[K] & AccountSupportCallable>);
    }
    const state = await guarded.readiness();
    return state.kind === "ready" ? binding.commerce<K>(...args) : state;
  }
  const services = { ...guarded, commerce };
  const entries = Object.entries(binding.operations);
  const routes = (input.routes ?? []).map(route => {
    const entry = entries.find(([, operation]) => operation === route.handle);
    if (!entry || entry[1] === null) throw new Error("account_support_entry_operation_required");
    return { ...route, handle: services.operations[entry[0]] as Contribution["routes"][number]["handle"] };
  });
  const selected = input.enabled === true;
  const contribution = createAccountSupportContribution({ ...input, requiredSchema: schema,
    accountSupport: selected ? services.operations : {},
    routes: selected ? routes : [],
  });
  return { services, readiness: services.readiness, schema, commerceOwner, commerceRegistry: commerceOwner ? input.commerceRegistry ?? null : null,
    contributions: [...contribution.contributions, ...(commerceOwner?.contributions ?? [])],
    ports: { ...contribution.ports, ...commerceOwner?.ports },
    routes: { ...contribution.routes, ...commerceOwner?.routes },
    triggers: { ...contribution.triggers, ...commerceOwner?.triggers },
  };
}
