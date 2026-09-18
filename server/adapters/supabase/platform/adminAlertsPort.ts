import type {
  PlatformAlertLedgerRow,
  WatchdogHeartbeatRow,
} from "../../../../src/domains/platform/adminAlertsView.js";
import type { AdminAlertsReadPort } from "../../../domains/platform/adminAlertsHandlers.js";
import { WATCHDOG_HEARTBEAT_JOB_NAME } from "./watchdogHeartbeat.js";

/**
 * `platform_alerts` and `platform_job_controls` both REVOKE ALL from `authenticated`
 * (migrations 20260606100000, 20260601223000), so these reads must run as service-role.
 * A user-scoped client returns a permission error, not an empty set — RLS policies
 * exist on these tables but the grants behind them do not.
 *
 * Elevation goes through the platform data gateway rather than a client built in the
 * route, per the admin BFF service-role boundary. Admin identity is verified
 * separately, before this port is ever called.
 */

const ALERT_COLUMNS =
  "id,dedupe_key,owner,severity,status,title,message,support_code,runbook_url,first_seen_at,last_seen_at,snoozed_until";

/**
 * Headroom over the 50 rows we return: the summary counts stay accurate even when
 * the displayed list is truncated.
 */
const ALERT_FETCH_LIMIT = 200;

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message?: string } | null }>;
type AlertsQuery<T> = QueryResult<T> & {
  select: (columns: string) => AlertsQuery<T>;
  in: (column: string, values: readonly string[]) => AlertsQuery<T>;
  eq: (column: string, value: string) => AlertsQuery<T>;
  order: (column: string, options: { ascending: boolean }) => AlertsQuery<T>;
  limit: (count: number) => AlertsQuery<T>;
  maybeSingle: () => QueryResult<T>;
};

interface AlertsGatewayClient {
  from: <T>(table: string) => AlertsQuery<T>;
}

interface AlertsDataGateway {
  asService<T>(work: (gateway: unknown) => Promise<T>): Promise<T>;
}

export function createGatewayAdminAlertsReadPort(gateway: AlertsDataGateway): AdminAlertsReadPort {
  return {
    async listLiveAlerts(): Promise<PlatformAlertLedgerRow[]> {
      return gateway.asService(async (client) => {
        const { data, error } = await (client as AlertsGatewayClient)
          .from<PlatformAlertLedgerRow[]>("platform_alerts")
          .select(ALERT_COLUMNS)
          .in("status", ["open", "acknowledged"])
          .order("severity", { ascending: true })
          .order("last_seen_at", { ascending: false })
          .limit(ALERT_FETCH_LIMIT);
        if (error) throw new Error(error.message ?? "platform_alerts read failed");
        return data ?? [];
      });
    },

    async readWatchdogHeartbeat(): Promise<WatchdogHeartbeatRow> {
      return gateway.asService(async (client) => {
        const { data, error } = await (client as AlertsGatewayClient)
          .from<{ last_success_at: string | null }>("platform_job_controls")
          .select("last_success_at")
          .eq("job_name", WATCHDOG_HEARTBEAT_JOB_NAME)
          .maybeSingle();
        if (error) throw new Error(error.message ?? "platform_job_controls read failed");
        // A missing row means the watchdog has never reported here; buildHeartbeat
        // turns that into `stale`, which the pill renders as "unknown".
        return data ?? null;
      });
    },
  };
}
