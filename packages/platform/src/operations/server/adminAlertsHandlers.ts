import { createBffResponder, type BffResponderOptions } from "../../bff/index.js";
import type { HttpRequest, HttpResponse } from "../../http/index.js";
import { adminAlertsOverviewResponseSchema } from "../index.js";
import { buildAlertsOverview } from "../index.js";
import type {
  PlatformAlertLedgerRow,
  WatchdogHeartbeatRow,
} from "../index.js";
import type { OperationsAuthorizationResult } from "../contracts/index.js";
type AuthorizeAdmin = () => Promise<OperationsAuthorizationResult>;

export interface AdminAlertsReadPort {
  listLiveAlerts(): Promise<PlatformAlertLedgerRow[]>;
  readWatchdogHeartbeat(): Promise<WatchdogHeartbeatRow>;
}

export interface AdminAlertsOverviewDeps extends BffResponderOptions {
  readPort: AdminAlertsReadPort;
  authorizeAdmin: AuthorizeAdmin;
  now?: () => Date;
}

export function createAdminAlertsOverviewHandler({
  readPort,
  authorizeAdmin,
  now = () => new Date(), responseRequestId,
}: AdminAlertsOverviewDeps) {
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = createBffResponder({ responseRequestId });
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
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
