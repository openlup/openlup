import { readProcessEnvironment } from "../../../../_lib/observability/runtimeProvenance.js";
import { withObservedRoute } from "../../../../_lib/observability/route.js";
import { handlePrivacyRequest } from "../../../../runtime/auth/privacyBinding.js";
export default withObservedRoute({ route: "/api/bff/admin/identity/privacy/export", domain: "auth", surface: "admin", risk: "mutation" },
  async (req, res) => { await handlePrivacyRequest("export", req, res, readProcessEnvironment()); });
