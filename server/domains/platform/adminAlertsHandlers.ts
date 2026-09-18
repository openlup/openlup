import { sendBffError, sendBffSuccess, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { adminAlertsOverviewResponseSchema } from "../../../src/domains/platform/adminAlertsContracts.js";
import { buildAlertsOverview } from "../../../src/domains/platform/adminAlertsView.js";
import type {
  PlatformAlertLedgerRow,
  WatchdogHeartbeatRow,
} from "../../../src/domains/platform/adminAlertsView.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";

export interface AdminAlertsReadPort {
  listLiveAlerts(): Promise<PlatformAlertLedgerRow[]>;
  readWatchdogHeartbeat(): Promise<WatchdogHeartbeatRow>;
}

interface AdminAlertsOverviewDeps {
  readPort: AdminAlertsReadPort;
  authorizeAdmin: AuthorizeAdmin;
  now?: () => Date;
}

export function createAdminAlertsOverviewHandler({
  readPort,
  authorizeAdmin,
  now = () => new Date(),
}: AdminAlertsOverviewDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorization = await authorizeAdmin();
    if (authorization.ok === false) {
      sendBffError(res, authorization.code, authorization.message);
      return;
    }

    try {
      // Heartbeat and alerts are read together: an empty alert list is only
      // "healthy" if the watchdog actually reported recently.
      const [alerts, heartbeat] = await Promise.all([
        readPort.listLiveAlerts(),
        readPort.readWatchdogHeartbeat(),
      ]);

      const overview = buildAlertsOverview(alerts, heartbeat, now());
      const response = adminAlertsOverviewResponseSchema.safeParse(overview);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Admin alerts overview returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin alerts overview failed");
    }
  };
}
