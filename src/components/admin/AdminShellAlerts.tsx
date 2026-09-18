import { Bell } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AdminAlert, AdminAlertHealth } from "@/domains/platform/adminAlertsContracts";
import { cn } from "@/lib/utils";
import { useAdminAlertsOverview } from "./useAdminShellData";

const HEALTH_DOT: Record<AdminAlertHealth, string> = {
  ok: "bg-sage-mint",
  degraded: "bg-warm-amber",
  down: "bg-warm-coral",
  unknown: "bg-text-muted/50",
};

const SEVERITY_BADGE: Record<AdminAlert["severity"], string> = {
  p0: "border-warm-coral/30 bg-coral-tint text-warm-coral",
  p1: "border-warm-amber/30 bg-warm-sand text-teal-dark",
  p2: "border-warm-sand bg-offwhite text-text-muted",
  p3: "border-warm-sand bg-offwhite text-text-muted",
};

function relativeAge(iso: string, now: number, t: TFunction): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return t("admin:adminShell.alerts.ageMinutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t("admin:adminShell.alerts.ageHours", { count: hours });
  return t("admin:adminShell.alerts.ageDays", { count: Math.round(hours / 24) });
}

function formatUtc(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

function AlertRow({ alert, now }: { alert: AdminAlert; now: number }) {
  const { t } = useTranslation("admin");
  return (
    <li className="border-b border-warm-sand/60 px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            "mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-xxs font-bold uppercase",
            SEVERITY_BADGE[alert.severity],
          )}
        >
          {alert.severity}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs-plus font-bold text-teal-dark">{alert.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xxs text-text-muted">{alert.message}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xxs text-text-muted">
            <span>{relativeAge(alert.lastSeenAt, now, t)}</span>
            {alert.snoozedUntil ? (
              <span className="font-bold text-text-muted">
                {t("admin:adminShell.alerts.snoozedUntil", { until: formatUtc(alert.snoozedUntil) })}
              </span>
            ) : null}
            {alert.supportCode ? <span className="font-mono">{alert.supportCode}</span> : null}
            {alert.runbookUrl ? (
              <a className="font-bold text-teal underline" href={alert.runbookUrl}>
                {t("admin:adminShell.alerts.runbook")}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function AlertSection({
  titleKey,
  alerts,
  now,
}: {
  titleKey: string;
  alerts: AdminAlert[];
  now: number;
}) {
  const { t } = useTranslation("admin");
  if (alerts.length === 0) return null;
  return (
    <div>
      <p className="bg-offwhite px-3 py-1.5 text-xxs font-bold uppercase text-text-muted">
        {t(titleKey, { count: alerts.length })}
      </p>
      <ul>
        {alerts.map((alert) => (
          <AlertRow key={alert.id} alert={alert} now={now} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Health pill and notification bell.
 *
 * Both open the same popover on purpose. The pill reflects every lane while the
 * bell counts only operator-actionable alerts, so a platform-owned incident would
 * otherwise render a red pill next to a bell showing zero — an alarming state with
 * nothing to click. Two sections in one panel keep every badge state explainable.
 */
export function AdminShellAlerts() {
  const { t } = useTranslation("admin");
  const { enabled, overview, isError } = useAdminAlertsOverview();

  if (!enabled) return null;

  // No data is never rendered as healthy: loading and failure both read "unknown".
  const health: AdminAlertHealth = isError || !overview ? "unknown" : overview.health;
  const bellCount = overview?.summary.commercePageableCount ?? 0;
  const now = overview ? Date.parse(overview.generatedAt) : Date.now();
  const commerceAlerts = overview?.alerts.filter((alert) => alert.lane === "commerce") ?? [];
  const platformAlerts = overview?.alerts.filter((alert) => alert.lane === "platform") ?? [];
  const snoozedAlerts = overview?.snoozedAlerts ?? [];

  const panel = (
    <PopoverContent align="end" className="w-80 overflow-hidden p-0">
      <div className="border-b border-warm-sand px-3 py-2">
        <p className="text-xs-plus font-bold text-teal-dark">{t(`admin:adminShell.health.${health}`)}</p>
        <p className="mt-0.5 text-xxs text-text-muted">
          {overview?.heartbeat.lastSuccessAt
            ? t("admin:adminShell.alerts.checkedAt", {
                age: relativeAge(overview.heartbeat.lastSuccessAt, Date.now(), t),
              })
            : t("admin:adminShell.alerts.neverChecked")}
        </p>
      </div>
      <div className="max-h-96 overflow-y-auto">
        <AlertSection titleKey="admin:adminShell.alerts.yourQueue" alerts={commerceAlerts} now={now} />
        <AlertSection titleKey="admin:adminShell.alerts.platform" alerts={platformAlerts} now={now} />
        <AlertSection
          titleKey="admin:adminShell.alerts.controlledExceptions"
          alerts={snoozedAlerts}
          now={now}
        />
        {commerceAlerts.length === 0 && platformAlerts.length === 0 && snoozedAlerts.length === 0 ? (
          <p className="px-3 py-4 text-center text-xxs text-text-muted">
            {isError ? t("admin:adminShell.alerts.unavailable") : t("admin:adminShell.alerts.empty")}
          </p>
        ) : null}
      </div>
    </PopoverContent>
  );

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="focus-ring hidden min-h-9 items-center gap-2 rounded-full bg-white px-3 text-xs font-bold text-teal-dark md:flex"
          >
            <span className={cn("h-2 w-2 rounded-full", HEALTH_DOT[health])} />
            {t(`admin:adminShell.health.${health}`)}
          </button>
        </PopoverTrigger>
        {panel}
      </Popover>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t("admin:adminShell.notifications")}
            className="focus-ring relative flex h-9 w-9 items-center justify-center rounded-full border border-warm-sand bg-white text-teal-dark"
          >
            <Bell size={16} aria-hidden="true" />
            {bellCount > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warm-coral px-1 text-xxs font-bold text-teal-dark">
                {bellCount}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        {panel}
      </Popover>
    </>
  );
}
