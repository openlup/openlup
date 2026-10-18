import { withObservedRoute } from "../../_lib/observability/route.js";
import type { RouteEntry } from "@openlup/platform/bff";
import { preflightAdminBffRoute } from "./adminAuthBinding.js";
import { handlePrivacyRequest } from "./privacyBinding.js";
export function privacyRoutes(env: Record<string, string | undefined>): readonly RouteEntry[] {
  return (["export", "erase"] as const).map(operation => {
    const route = `/api/bff/admin/identity/privacy/${operation}`;
    return { route, pattern: new RegExp(`^${route}$`), params: [], ...(env.PLATFORM_BUNDLE === "node-postgres" ? { availability: "direct-postgres" as const } : {}),
      handler: withObservedRoute({ route, domain: "auth", surface: "admin", risk: "mutation" },
        async (req, res) => {
          if (!(await preflightAdminBffRoute(req, res, route, env))) return;
          await handlePrivacyRequest(operation, req, res, env);
        }) };
  });
}
