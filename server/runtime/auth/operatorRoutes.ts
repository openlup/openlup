import { withObservedRoute } from "../../_lib/observability/route.js";
import type { RouteEntry } from "@openlup/platform/bff";
import { createOperatorSessionBinding } from "./operatorSessionBinding.js";
import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { resolveAdminAuthBinding } from "./adminAuthBinding.js";
import { readBearerToken } from "@openlup/platform/identity";
export function operatorRoutes(
  env: Record<string, string | undefined>,
  createSessionBinding = createOperatorSessionBinding,
  suppliedRoutes: readonly RouteEntry[] = [],
): readonly RouteEntry[] {
  if (env.PLATFORM_BUNDLE !== "node-postgres") return [];
  return ["magic-link", "verify-otp", "me"].map(operation => {
    const route = `/api/bff/admin/platform/${operation}`;
    const suppliedHandler = suppliedRoutes.find(entry => entry.route === route)?.handler;
    return { route, pattern: new RegExp(`^${route}$`), params: [], availability: "direct-postgres" as const,
      handler: withObservedRoute({ route, domain: "platform", surface: "admin", risk: "mutation" }, async (req, res) => {
        if (suppliedHandler) { await suppliedHandler(req, res); return; }
        if (operation === "me") {
          if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);
          try {
            const binding = resolveAdminAuthBinding(env).binding;
            if (!binding) throw new Error("operator_auth_unconfigured");
            const token = readBearerToken(req);
            const result = await binding.run(token, auth => auth.authorize(token));
            if (result.ok === false) return sendBffError(res, result.code, result.message);
            return sendBffSuccess(res, { isAdmin: true, role: result.role });
          } catch { return sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator authorization unavailable"); }
        }
        if (req.method !== "POST") return sendMethodNotAllowed(res, ["POST"]);
        let binding: ReturnType<typeof createOperatorSessionBinding> | undefined;
        try {
          binding = createSessionBinding(env);
          await (operation === "magic-link" ? binding.requestChallenge : binding.verifyChallenge)(req, res);
        } catch { sendBffError(res, "UPSTREAM_UNAVAILABLE", "Operator authentication unavailable"); }
        finally { await binding?.close(); }
      }),
    };
  });
}
