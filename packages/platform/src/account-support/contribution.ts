import type { AccountSupportCapabilities } from "./contracts/index.js";
import type { AccountSupportCallable, AccountSupportOperations } from "./bindings.js";

export type AccountSupportBindingRefusal = { readonly kind: "refused"; readonly code: "disabled" | "schema_unknown" | "schema_unsatisfied" };
export type AccountSupportReadiness = { readonly kind: "ready" } | AccountSupportBindingRefusal;
export type GuardedAccountSupportOperation<F> = F extends AccountSupportCallable
  ? (...args: Parameters<F>) => Promise<Awaited<ReturnType<F>> | AccountSupportBindingRefusal> : null;
export type GuardedAccountSupportOperations<O extends AccountSupportOperations> = { readonly [K in keyof O]: GuardedAccountSupportOperation<O[K]> };

/** One guard per callable identity, shared by service, port and route aliases. */
export function createAccountSupportServices<O extends AccountSupportOperations>(input: {
  enabled?: boolean;
  capabilities: AccountSupportCapabilities;
  operations: O;
  readiness(): Promise<AccountSupportReadiness>;
}) {
  const enabled = input.enabled === true, observe = input.readiness;
  async function readiness(): Promise<AccountSupportReadiness> {
    return enabled ? observe() : { kind: "refused", code: "disabled" };
  }
  const guards = new Map<AccountSupportCallable, AccountSupportCallable>();
  const operations = Object.fromEntries(Object.entries(input.operations).map(([key, operation]) => {
    if (operation === null) return [key, null];
    let guarded = guards.get(operation);
    if (!guarded) {
      guarded = async (...args: never[]) => {
        const state = await readiness();
        return state.kind === "ready" ? operation(...args) : state;
      };
      guards.set(operation, guarded);
    }
    return [key, guarded];
  })) as GuardedAccountSupportOperations<O>;
  return Object.freeze({ capabilities: input.capabilities, readiness, operations: Object.freeze(operations) });
}
