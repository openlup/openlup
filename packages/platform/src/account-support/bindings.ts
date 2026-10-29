import type { AccountSupportCapabilities } from "./contracts/index.js";

/** Already bound owner methods; the host retains authentication and dispatch. */
export type AccountSupportCallable = (...args: never[]) => unknown;
export type AccountSupportOperations = Readonly<Record<string, AccountSupportCallable | null>>;
export type AccountSupportHostBindingRequired = { readonly kind: "unsupported"; readonly code: "host_binding_required" };
type CommerceArguments<F> = F extends AccountSupportCallable ? Parameters<F> : unknown[];
const HOST_BINDING_REQUIRED: AccountSupportHostBindingRequired = Object.freeze({ kind: "unsupported", code: "host_binding_required" });

/** The host must bind one executor per logical operation. This factory captures/freezes its graph and operation maps but does not validate executor cardinality or identity. */
export function createAccountSupportBindings<O extends AccountSupportOperations, C extends AccountSupportOperations = AccountSupportOperations>(input: {
  graph: "managed" | "native";
  capabilities: AccountSupportCapabilities;
  operations: O;
  commerce?: C | null;
}) {
  if (input.graph !== input.capabilities.graph) throw new Error("customer_graph_mismatch");
  const capabilities: Readonly<AccountSupportCapabilities> = Object.freeze({ ...input.capabilities, subscriptions: Object.freeze({ ...input.capabilities.subscriptions }) });
  const operations = Object.freeze({ ...input.operations });
  const commerce = Object.freeze({ ...input.commerce });
  return Object.freeze({ graph: input.graph, capabilities, operations,
    /** No draft commerce import or fallback executor. An absent record/member is explicit. */
    async commerce<K extends keyof C & string>(key: K, ...args: CommerceArguments<C[K]>): Promise<Awaited<ReturnType<Extract<C[K], AccountSupportCallable>>> | AccountSupportHostBindingRequired> {
      const operation = Object.hasOwn(commerce, key) ? commerce[key] : null;
      return operation ? operation(...args as never[]) as Awaited<ReturnType<Extract<C[K], AccountSupportCallable>>> : HOST_BINDING_REQUIRED;
    },
  });
}
