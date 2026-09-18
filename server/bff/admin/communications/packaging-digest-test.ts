import { withObservedRoute } from "../../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";

export type RetiredPackagingDigestRouteDependencies = {
  readRequest?: () => unknown;
  readEnv?: () => unknown;
  readToken?: () => unknown;
  createAuthClient?: () => unknown;
  createPort?: () => unknown;
  authorize?: () => unknown;
  fetch?: () => unknown;
};

export function createRetiredPackagingDigestRoute(
  _dependencies: RetiredPackagingDigestRouteDependencies = {},
) {
  return async function handler(_req: VercelRequest, res: VercelResponse): Promise<void> {
    res.status(404).end();
  };
}

export default withObservedRoute({
  route: "/api/bff/admin/communications/packaging-digest-test",
  domain: "communications",
  surface: "admin",
  risk: "mutation",
}, createRetiredPackagingDigestRoute());
