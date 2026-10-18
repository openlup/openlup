import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { AdminAuthPort, AdminPrincipalRole } from "./ports.js";
import { readBearerToken } from "./adminAuthorization.js";
import { refusesMachineActorRequest, sendMachineActorWriteRefused } from "./machineActorWriteFence.js";

export interface AdminAuthBinding {
  readonly identity: string;
  run<T>(accessToken: string | null, work: (auth: AdminAuthPort) => Promise<T>): Promise<T>;
}
export function createAdminBffPreflight(options: IdentityResponseOptions & {
  allowedRoles: (route: string) => readonly AdminPrincipalRole[] | null;
  resolveBinding: () => { binding?: AdminAuthBinding; error?: string };
  machineWriteRoutes?: readonly string[];
  managedEnvironmentMessage?: string;
}) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createIdentityResponder(options);
  return async (req: HttpRequest, res: HttpResponse, route: string): Promise<boolean> => {
    const allowedRoles = options.allowedRoles(route);
    if (!allowedRoles) return true;
    const resolved = options.resolveBinding();
    if (!resolved.binding) {
      if (resolved.error === "managed_admin_auth_env_required") {
        sendBffError(res, "INTERNAL", options.managedEnvironmentMessage ?? "Identity environment is not configured");
      } else sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return false;
    }
    const accessToken = readBearerToken(req);
    try {
      const authz = await resolved.binding.run(accessToken, (auth) => auth.authorize(accessToken, { allowedRoles }));
      if (authz.ok === false) {
        sendBffError(res, authz.code, authz.message);
        return false;
      }
      if (resolved.binding.identity !== "node-postgres"
        && refusesMachineActorRequest(route, req.method, authz.isMachineActor, options.machineWriteRoutes)) {
        sendMachineActorWriteRefused(res, options);
        return false;
      }
      return true;
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
      return false;
    }
  };
}
