import { useQuery } from "@tanstack/react-query";
import { getAdminCommerceOrders } from "@/domains/commerce/omsClient";
import type { AdminCommerceOrdersListRequest } from "@/domains/commerce/omsContracts";
import { getAdminAlertsOverview } from "@/domains/platform/adminAlertsClient";
import type { AdminAlertsOverviewResponse } from "@/domains/platform/adminAlertsContracts";
import { useAuth } from "@/lib/authContext";
import { platformAlertsAdminEnabled } from "@/lib/flags";
import { isAdminOmsSurfaceAllowed } from "@/lib/hiddenSurfaceAccess";

/**
 * Shell-scoped data hooks.
 *
 * The admin shell renders on every admin route and cannot own a page-level query,
 * so these live here rather than inline in a page (the repo's usual convention).
 * Keep this module small — it is not the seed of a general hooks layer.
 */

/**
 * Shared with DashboardPage on purpose: an identical queryKey makes react-query
 * dedupe the nav badge, both SidebarNav instances (mobile drawer + desktop aside)
 * and the dashboard attention tiles into a single request.
 */
export const ADMIN_OMS_ATTENTION_REQUEST: AdminCommerceOrdersListRequest = {
  page: 1,
  pageSize: 6,
  sort: "attention_priority_desc",
  attentionOnly: true,
};

export const ADMIN_OMS_ATTENTION_QUERY_KEY = "admin-dashboard-oms-queue";

/**
 * Orders awaiting an operator's hand, counted server-side over the whole match
 * set (not the returned page). Returns null while loading or on failure so the
 * badge disappears rather than showing a stale or invented number.
 */
export function useOmsAttentionCount(): number | null {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  // The shell renders on every admin route, including deployments where the OMS
  // surface is hidden. Without this gate the badge would query OMS for admins who
  // cannot even see the nav entry — exactly the leak commerceOmsBoundary guards.
  const omsAllowed = isAdminOmsSurfaceAllowed();
  const query = useQuery({
    queryKey: [ADMIN_OMS_ATTENTION_QUERY_KEY, ADMIN_OMS_ATTENTION_REQUEST, accessToken],
    enabled: omsAllowed && Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceOrders(accessToken, ADMIN_OMS_ATTENTION_REQUEST);
    },
    staleTime: 30_000,
    retry: false,
  });
  return query.data?.summaryCounts?.needsAttention ?? null;
}

/** Refetch cadence for the alerts overview; the watchdog itself ticks every 10 minutes. */
const ALERTS_REFRESH_MS = 60_000;

export interface AdminAlertsState {
  enabled: boolean;
  overview: AdminAlertsOverviewResponse | null;
  isError: boolean;
}

/**
 * Platform alerts behind the shell's health pill and notification bell.
 *
 * `overview` stays null while loading and on failure. Callers must render the
 * pill as "unknown" in that case — never as healthy. There is deliberately no
 * optimistic default here.
 */
export function useAdminAlertsOverview(): AdminAlertsState {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const enabled = platformAlertsAdminEnabled();
  const query = useQuery({
    queryKey: ["admin-shell-platform-alerts", accessToken],
    enabled: enabled && Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminAlertsOverview(accessToken);
    },
    staleTime: 30_000,
    retry: false,
    refetchInterval: () => (document.hidden ? false : ALERTS_REFRESH_MS),
  });
  return { enabled, overview: query.data ?? null, isError: query.isError };
}
