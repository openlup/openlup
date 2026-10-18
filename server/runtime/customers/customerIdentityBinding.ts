import { createCustomerIdentityBindingFactory } from "@openlup/platform/identity";
import { createCustomerClient } from "../../_lib/customer-domain/auth.js";
import { readCustomerSupabaseReadEnv } from "../../bff/customers/shared.js";
import { bindRequestActorDataPort } from "../dataBinding.js";
const createBinding = createCustomerIdentityBindingFactory({
  loadJwt: () => import("jose"),
  createManagedClient: createCustomerClient,
  // The managed read environment stays process-wide, as before the import; the request env selects only the bundle.
  readManagedEnv: () => readCustomerSupabaseReadEnv(),
  bindRequestActorDataPort: (token, env) => bindRequestActorDataPort(token, env) as never,
});
export function createCustomerIdentityBinding(
  req: Parameters<typeof createBinding>[0],
  env: Record<string, string | undefined> = process.env,
  options: Parameters<typeof createBinding>[2] = {},
) {
  return createBinding(req, env, options);
}
