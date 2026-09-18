import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AdminMetricCard, AdminPanel, AdminSectionHeader, AdminSegmented } from "@/components/admin/AdminSurface";
import { useAuth } from "@/lib/authContext";
import { getAdminCommerceRenewalExceptions } from "@/domains/commerce/omsClient";
import type { AdminCommerceRenewalExceptionsResponse } from "@/domains/commerce/renewalExceptionContracts";
import type { DunningRecoveryDimension } from "@/domains/commerce/dunningRecoveryContracts";
import { AdminOmsErrorState } from "./AdminOmsErrorState";

type Baseline = NonNullable<AdminCommerceRenewalExceptionsResponse["dunningRecovery"]>;

const WINDOW_OPTIONS = ["30", "90", "180", "365"] as const;
type WindowOption = (typeof WINDOW_OPTIONS)[number];

export default function DunningRecoveryPage() {
  const { t } = useTranslation("admin");
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [windowDays, setWindowDays] = useState<WindowOption>("90");

  const request = useMemo(
    () => ({ page: 1, pageSize: 1, windowDays: Number(windowDays) }),
    [windowDays],
  );

  const query = useQuery({
    queryKey: ["admin-dunning-recovery", request, accessToken],
    enabled: Boolean(accessToken),
    queryFn: async ({ signal }) => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminCommerceRenewalExceptions(accessToken, request, { signal });
    },
    staleTime: 60_000,
    retry: false,
  });

  const baseline = query.data?.dunningRecovery;

  return (
    <div data-testid="admin-dunning-recovery-page" className="p-4 text-teal-dark md:p-6 xl:p-8">
      <AdminSectionHeader
        eyebrow={t("admin:adminDunningRecovery.previewLabel")}
        title={t("admin:adminDunningRecovery.title")}
        description={t("admin:adminDunningRecovery.subtitle")}
        actions={
          <AdminSegmented<WindowOption>
            value={windowDays}
            onChange={setWindowDays}
            options={WINDOW_OPTIONS.map((value) => ({
              value,
              label: t("admin:adminDunningRecovery.window.option", { count: Number(value) }),
            }))}
          />
        }
      />

      {query.isError ? (
        <AdminOmsErrorState
          testId="admin-dunning-recovery-error"
          title={t("admin:adminDunningRecovery.errors.title")}
          description={t("admin:adminDunningRecovery.errors.description")}
          retryLabel={t("admin:adminDunningRecovery.errors.retry")}
          retrying={query.isFetching}
          onRetry={() => void query.refetch()}
        />
      ) : null}

      {query.isLoading ? (
        <p className="flex items-center gap-2 py-12 text-sm text-text-muted">
          <Loader2 aria-hidden="true" className="animate-spin" size={18} />
          {t("admin:adminDunningRecovery.loading")}
        </p>
      ) : null}

      {!query.isError && !query.isLoading && !baseline ? (
        <Notice testId="admin-dunning-recovery-absent" title={t("admin:adminDunningRecovery.absent.title")}>
          {t("admin:adminDunningRecovery.absent.description")}
        </Notice>
      ) : null}

      {baseline ? <Baselines baseline={baseline} /> : null}
    </div>
  );
}

function Baselines({ baseline }: { baseline: Baseline }) {
  const { t } = useTranslation("admin");
  // Amounts are summed per case regardless of currency, so a mixed window's
  // money totals are not a quantity anyone may read. Money is rendered only when
  // the window resolved exactly one currency.
  const money = baseline.mixedCurrencies ? null : baseline.currency;

  return (
    <div className="flex flex-col gap-5">
      {baseline.truncated ? (
        <Notice testId="admin-dunning-recovery-truncated" title={t("admin:adminDunningRecovery.truncated.title")}>
          {t("admin:adminDunningRecovery.truncated.description")}
        </Notice>
      ) : null}

      {baseline.mixedCurrencies ? (
        <Notice testId="admin-dunning-recovery-mixed-currencies" title={t("admin:adminDunningRecovery.mixedCurrencies.title")}>
          {t("admin:adminDunningRecovery.mixedCurrencies.description")}
        </Notice>
      ) : null}

      <div data-testid="admin-dunning-recovery-metrics" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <AdminMetricCard tone="teal" label={t("admin:adminDunningRecovery.metrics.opened")} value={baseline.opened.count} />
        <AdminMetricCard tone="good" label={t("admin:adminDunningRecovery.metrics.recovered")} value={baseline.recovered.count} />
        <AdminMetricCard tone="bad" label={t("admin:adminDunningRecovery.metrics.expired")} value={baseline.expired.count} />
        <AdminMetricCard tone="neutral" label={t("admin:adminDunningRecovery.metrics.cancelled")} value={baseline.cancelled.count} />
        <AdminMetricCard tone="neutral" label={t("admin:adminDunningRecovery.metrics.resumedUnpaid")} value={baseline.resumedUnpaid.count} />
        <AdminMetricCard tone="warn" label={t("admin:adminDunningRecovery.metrics.stillOpen")} value={baseline.stillOpen.count} />
        <AdminMetricCard tone="good" label={t("admin:adminDunningRecovery.metrics.rateByCount")} value={formatRate(baseline.recoveryRateByCount)} />
        <AdminMetricCard tone="good" label={t("admin:adminDunningRecovery.metrics.rateByAmount")} value={formatRate(baseline.recoveryRateByAmount)} />
      </div>

      <p className="text-sm text-text-muted">{t("admin:adminDunningRecovery.denominatorNote")}</p>

      <AdminPanel className="p-4">
        <h2 className="mb-1 font-display text-lg font-semibold">{t("admin:adminDunningRecovery.attribution.title")}</h2>
        <p className="mb-3 text-sm text-text-muted">{t("admin:adminDunningRecovery.attribution.note")}</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin:adminDunningRecovery.attribution.column")}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.recovered")}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(["automaticRetry", "customerRedeem", "unattributed"] as const).map((key) => (
              <TableRow key={key} data-testid={`admin-dunning-recovery-attribution-${key}`}>
                <TableCell>{t(`admin:adminDunningRecovery.attribution.${key}`)}</TableCell>
                <TableCell className="text-right tabular-nums">{baseline.recoveredByAttribution[key].count}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatMoney(baseline.recoveredByAttribution[key].amountMinor, money)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AdminPanel>

      <Breakdown
        testId="admin-dunning-recovery-by-rung"
        title={t("admin:adminDunningRecovery.byRung.title")}
        column={t("admin:adminDunningRecovery.byRung.column")}
        note={t("admin:adminDunningRecovery.byRung.note")}
        rows={baseline.byRung}
        money={money}
      />
      <Breakdown
        testId="admin-dunning-recovery-by-class"
        title={t("admin:adminDunningRecovery.byClass.title")}
        column={t("admin:adminDunningRecovery.byClass.column")}
        note={`${t("admin:adminDunningRecovery.byClass.epoch")} ${t("admin:adminDunningRecovery.byClass.classifierCaveat")}`}
        rows={baseline.byClass}
        money={money}
      />
      <Breakdown
        testId="admin-dunning-recovery-by-rail"
        title={t("admin:adminDunningRecovery.byRail.title")}
        column={t("admin:adminDunningRecovery.byRail.column")}
        note={t("admin:adminDunningRecovery.byRail.note")}
        rows={baseline.byRail}
        money={money}
      />
    </div>
  );
}

function Breakdown({
  testId,
  title,
  column,
  note,
  rows,
  money,
}: {
  testId: string;
  title: string;
  column: string;
  note: string;
  rows: Record<string, DunningRecoveryDimension>;
  money: string | null;
}) {
  const { t } = useTranslation("admin");
  const entries = Object.entries(rows).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }));

  return (
    <AdminPanel testId={testId} className="p-4">
      <h2 className="mb-1 font-display text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-sm text-text-muted">{note}</p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{column}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.opened")}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.recovered")}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.rateByCount")}</TableHead>
              <TableHead className="text-right">{t("admin:adminDunningRecovery.table.rateByAmount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-text-muted">
                  {t("admin:adminDunningRecovery.table.empty")}
                </TableCell>
              </TableRow>
            ) : (
              entries.map(([key, entry]) => (
                <TableRow key={key}>
                  {/* The key is whatever the database returned. Never a label this
                      page invented, so an unrecognised value stays readable. */}
                  <TableCell className="font-mono text-xs">{key}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.opened.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{entry.recovered.count}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(entry.recoveryRateByCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatRate(entry.recoveryRateByAmount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {money ? null : (
        <p className="mt-3 text-xs text-text-muted">{t("admin:adminDunningRecovery.table.moneyUnavailable")}</p>
      )}
    </AdminPanel>
  );
}

function Notice({ testId, title, children }: { testId: string; title: string; children: string }) {
  return (
    <Alert data-testid={testId} className="border-warm-amber/40 bg-warm-sand text-teal-dark">
      <AlertTriangle aria-hidden="true" className="text-warm-amber" size={18} />
      <AlertTitle className="text-teal-dark">{title}</AlertTitle>
      <AlertDescription className="text-text-muted">{children}</AlertDescription>
    </Alert>
  );
}

/** `null` is a refusal the baseline made on purpose, so it is shown as one. */
function formatRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function formatMoney(amountMinor: number, currency: string | null): string {
  return currency === null ? "n/a" : `${(amountMinor / 100).toFixed(2)} ${currency}`;
}
