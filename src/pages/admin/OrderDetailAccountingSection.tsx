import { Loader2 } from "lucide-react";
import type { TFunction } from "i18next";
import type { AdminAccountingOrderSummary } from "@/domains/accounting/invoiceContracts";
import { formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { AdminOmsErrorState } from "./AdminOmsErrorState";
import { DetailSection, InfoBlock } from "./OrderDetailBlocks";
import { formatDate } from "./ordersPageUtils";

export function OrderDetailAccountingSection({
  summary,
  isLoading,
  isError,
  isFetching,
  locale,
  t,
  onRetry,
}: {
  summary: AdminAccountingOrderSummary | null;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  locale: string;
  t: TFunction;
  onRetry: () => void;
}) {
  return (
    <DetailSection
      testId="admin-oms-accounting-section"
      variant="plain"
      title={t("admin:adminOms.accounting.title")}
    >
      {isLoading ? (
        <div className="rounded-lg border border-warm-sand bg-white p-4 text-sm text-text-muted" aria-live="polite">
          <Loader2 className="mr-2 inline animate-spin" size={16} aria-hidden="true" />
          {t("admin:adminOms.accounting.loading")}
        </div>
      ) : isError ? (
        <AdminOmsErrorState
          testId="admin-oms-accounting-error"
          title={t("admin:adminOms.errors.accountingTitle")}
          description={t("admin:adminOms.errors.accountingDescription")}
          retryLabel={t("admin:adminOms.errors.retry")}
          retrying={isFetching}
          onRetry={onRetry}
        />
      ) : summary ? (
        <div className="grid gap-3 md:grid-cols-2">
          <InfoBlock
            label={t("admin:adminOms.accounting.invoiceStatus")}
            value={t(`admin:adminOms.accountingStatus.${summary.status}`)}
            meta={summary.invoice?.invoiceRef ?? t("admin:adminOms.accounting.noInvoice")}
          />
          <InfoBlock
            label={t("admin:adminOms.accounting.provider")}
            value={summary.invoice?.providerKind ?? t("admin:adminOms.accounting.notAvailable")}
            meta={summary.invoice?.providerInvoiceNumber ?? ""}
          />
          <InfoBlock
            label={t("admin:adminOms.accounting.ksef")}
            value={summary.invoice?.ksefStatus ?? t("admin:adminOms.accounting.notAvailable")}
            meta={summary.invoice?.ksefRequirement ?? ""}
          />
          {summary.invoice?.blockedReason ? (
            <InfoBlock
              label={t("admin:adminOms.accounting.blockedReason")}
              value={t(`admin:adminOms.accounting.blockedReasons.${summary.invoice.blockedReason}`, {
                defaultValue: summary.invoice.blockedReason,
              })}
              meta={t("admin:adminOms.accounting.blockedRecovery")}
            />
          ) : null}
          <InfoBlock
            label={t("admin:adminOms.accounting.outboxStatus")}
            value={outboxStatus(summary.outbox?.status ?? null, t)}
            meta={attemptMeta(summary, locale, t)}
          />
          <InfoBlock
            label={t("admin:adminOms.accounting.lastError")}
            value={lastErrorValue(summary, t)}
            meta={lastErrorMeta(summary, t)}
          />
          <InfoBlock
            label={t("admin:adminOms.accounting.recovery")}
            value={t(`admin:adminOms.accounting.guidance.${summary.recoveryGuidance}`)}
            meta={summary.outbox?.nextAttemptAt ? t("admin:adminOms.accounting.nextRetry", { value: formatDate(summary.outbox.nextAttemptAt, locale) }) : ""}
          />
          {(summary.documents?.length ?? 0) > 0 ? (
            <div className="space-y-2 md:col-span-2">
              <p className="text-sm font-semibold text-teal-dark">{t("admin:adminOms.accounting.documents")}</p>
              <ul className="grid gap-2 md:grid-cols-2">
                {(summary.documents ?? []).map((document) => (
                  <li key={document.documentKey} className="rounded-lg border border-warm-sand bg-white p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-teal-dark">
                        {document.providerInvoiceNumber ?? document.invoiceRef}
                      </span>
                      <span className="rounded-full bg-soft-sage px-2 py-0.5 text-xs font-semibold text-teal-dark">
                        {t(`admin:adminOms.accounting.documentRole.${document.role}`)}
                        {document.isCurrent ? ` · ${t("admin:adminOms.accounting.currentDocument")}` : ""}
                      </span>
                    </div>
                    <p className="mt-1 text-text-muted">
                      {t(`admin:adminOms.accountingStatus.${document.status}`, { defaultValue: document.status })}
                      {/* The document's OWN currency, not the deployment's. This line is
                          what an operator reads to check what a customer was invoiced,
                          and an invoice's denomination was fixed when it was issued -
                          reading a live settlement value here would relabel the archive
                          the first time the shop changed currency. */}
                      {document.totalGrossMinor === null
                        ? ""
                        : ` · ${formatCurrencyMinor(document.totalGrossMinor, { currency: document.currency, locale })}`}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {t(`admin:adminOms.accounting.emailState.${document.emailState}`)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </DetailSection>
  );
}

function outboxStatus(status: string | null, t: TFunction) {
  if (!status) return t("admin:adminOms.accounting.noOutbox");
  return t(`admin:adminOms.outboxStatus.${status}`, { defaultValue: status });
}

function attemptMeta(summary: AdminAccountingOrderSummary, locale: string, t: TFunction) {
  if (!summary.outbox) return "";
  const attempts = t("admin:adminOms.accounting.attemptCount", { count: summary.outbox.attemptCount ?? 0 });
  const retry = summary.outbox.nextAttemptAt
    ? t("admin:adminOms.accounting.nextRetry", { value: formatDate(summary.outbox.nextAttemptAt, locale) })
    : t("admin:adminOms.accounting.noRetryScheduled");
  return `${attempts} · ${retry}`;
}

function lastErrorValue(summary: AdminAccountingOrderSummary, t: TFunction) {
  const lastError = summary.outbox?.lastError;
  return lastError?.message ?? lastError?.code ?? t("admin:adminOms.accounting.noLastError");
}

function lastErrorMeta(summary: AdminAccountingOrderSummary, t: TFunction) {
  const lastError = summary.outbox?.lastError;
  if (!lastError) return "";
  return [
    lastError.code ? t("admin:adminOms.accounting.errorCode", { code: lastError.code }) : null,
    lastError.retryable === null ? null : t(`admin:adminOms.accounting.retryable.${lastError.retryable ? "yes" : "no"}`),
  ].filter(Boolean).join(" · ");
}
