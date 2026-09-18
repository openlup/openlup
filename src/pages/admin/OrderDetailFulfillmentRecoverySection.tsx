import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import type { TFunction } from "i18next";
import { AdminStatusPill } from "@/components/admin/AdminSurface";
import { Button } from "@/components/ui/button";
import { bffErrorMessage } from "@/lib/bff/errorMessage";
import type {
  OmsOrderDetail,
} from "@/domains/commerce/omsContracts";
import {
  type AdminPaidFulfillmentRecoveryCandidate,
  type AdminPaidFulfillmentRecoveryExecuteRequest,
  type AdminPaidFulfillmentRecoveryExecuteResponse,
  type AdminPaidFulfillmentRecoveryPreviewRequest,
  type AdminPaidFulfillmentRecoveryPreviewResponse,
} from "@/domains/commerce/recoveryOpsContracts";
import { DetailSection } from "./OrderDetailBlocks";

export type PreviewRecovery = (
  accessToken: string,
  request: AdminPaidFulfillmentRecoveryPreviewRequest,
) => Promise<AdminPaidFulfillmentRecoveryPreviewResponse>;

export type ExecuteRecovery = (
  accessToken: string,
  request: AdminPaidFulfillmentRecoveryExecuteRequest,
) => Promise<AdminPaidFulfillmentRecoveryExecuteResponse>;

type RecoveryState =
  | { status: "idle"; candidate: null; message: string | null }
  | { status: "previewing"; candidate: null; message: string | null }
  | { status: "ready"; candidate: AdminPaidFulfillmentRecoveryCandidate; message: string | null }
  | { status: "executing"; candidate: AdminPaidFulfillmentRecoveryCandidate; message: string | null }
  | { status: "done"; candidate: AdminPaidFulfillmentRecoveryCandidate; message: string | null }
  | { status: "blocked"; candidate: null; message: string };

export function OrderDetailFulfillmentRecoverySection({
  accessToken,
  detail,
  isPending,
  onRecovered,
  previewRecovery,
  executeRecovery,
  t,
}: {
  accessToken: string | undefined;
  detail: OmsOrderDetail;
  isPending: boolean;
  onRecovered: () => Promise<void>;
  previewRecovery: PreviewRecovery;
  executeRecovery: ExecuteRecovery;
  t: TFunction;
}) {
  const [state, setState] = useState<RecoveryState>({ status: "idle", candidate: null, message: null });
  const health = detail.fulfillmentHealth;
  useEffect(() => {
    setState({ status: "idle", candidate: null, message: null });
  }, [detail.orderId]);
  const safeBySnapshot = health.healthStatus === "missing_local_commitment" &&
    health.attentionReasons.includes("order_paid_outbox_discarded") &&
    Boolean(health.opaqueIds.outboxEventId);
  const candidateFromState = state.status === "ready" || state.status === "executing" || state.status === "done"
    ? state.candidate
    : null;
  const safeCandidate = candidateFromState?.orderId === detail.orderId ? candidateFromState : null;
  const ids = useMemo(() => [
    ["order", health.opaqueIds.orderId],
    ["fulfillment", health.opaqueIds.fulfillmentOrderId],
    ["outbox", health.opaqueIds.outboxEventId],
    ["dispatchRef", health.dispatchRefId],
    ["dispatchStatus", health.dispatchStatus],
    ["evidence", health.opaqueIds.latestEvidenceFulfillmentOrderId],
  ].filter(([, value]) => Boolean(value)), [health.dispatchRefId, health.dispatchStatus, health.opaqueIds]);

  const preview = async () => {
    if (!accessToken) return;
    setState({ status: "previewing", candidate: null, message: null });
    try {
      const response = await previewRecovery(accessToken, {
        operation: "preview",
        orderIds: [detail.orderId],
        minimumAgeSeconds: 60,
        limit: 10,
      });
      const candidate = response.candidates.find((row) =>
        row.orderId === detail.orderId &&
        row.recommendedAction === "requeue_discarded_order_paid_outbox" &&
        row.recoveryPosture === "automatic_local_requeue_safe" &&
        row.outboxEventId,
      );
      setState(candidate
        ? { status: "ready", candidate, message: null }
        : { status: "blocked", candidate: null, message: t("admin:adminOms.fulfillmentRecovery.noSafeCandidate") });
    } catch (error) {
      setState({ status: "blocked", candidate: null, message: errorMessage(error, t) });
    }
  };

  const execute = async () => {
    if (!accessToken || !safeCandidate?.outboxEventId) return;
    setState({ status: "executing", candidate: safeCandidate, message: null });
    try {
      await executeRecovery(accessToken, {
        operation: "execute",
        action: "requeue_discarded_order_paid_outbox",
        eventIds: [safeCandidate.outboxEventId],
        orderIds: [detail.orderId],
        reason: "operator confirmed local discarded order-paid event from OMS",
        minimumAgeSeconds: 60,
      });
      setState({
        status: "done",
        candidate: safeCandidate,
        message: t("admin:adminOms.fulfillmentRecovery.done"),
      });
      await onRecovered();
    } catch (error) {
      setState({ status: "ready", candidate: safeCandidate, message: errorMessage(error, t) });
    }
  };

  return (
    <DetailSection
      testId="admin-oms-fulfillment-recovery"
      title={t("admin:adminOms.fulfillmentRecovery.title")}
      subtitle={t("admin:adminOms.fulfillmentRecovery.subtitle")}
      actions={(
        <AdminStatusPill tone={statusTone(health.healthStatus)}>
          {t(`admin:adminOms.fulfillmentHealth.${health.healthStatus}`)}
        </AdminStatusPill>
      )}
    >
      <div className="space-y-2 text-sm">
        <p className="text-text-muted">
          {t("admin:adminOms.fulfillmentRecovery.reasons")}: {health.attentionReasons.length
            ? health.attentionReasons.map((reason) => t(`admin:adminOms.fulfillmentHealthReason.${reason}`, { defaultValue: reason })).join(", ")
            : t("admin:adminOms.detail.notAvailable")}
        </p>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {ids.map(([kind, value]) => (
            <span key={kind} className="rounded-full border border-warm-sand px-2 py-0.5 text-text-muted">
              {kind}: {kind === "dispatchStatus" ? String(value) : String(value).slice(0, 8)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-md border border-teal/20 bg-teal/5 p-3 text-sm text-text-muted">
        <p className="flex items-center gap-2 font-medium text-teal-dark">
          <ShieldCheck className="size-4" aria-hidden="true" />
          {t("admin:adminOms.fulfillmentRecovery.safety")}
        </p>
        <p className="mt-1">{t("admin:adminOms.fulfillmentRecovery.noProviderPost")}</p>
      </div>

      {state.message ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-warm-coral" role="status">
          <AlertTriangle className="size-4" aria-hidden="true" />
          {state.message}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="admin-oms-recovery-preview"
          disabled={!accessToken || isPending || state.status === "previewing" || state.status === "executing"}
          onClick={() => void preview()}
        >
          <RefreshCw className={["mr-1 size-4", state.status === "previewing" ? "animate-spin" : ""].join(" ")} aria-hidden="true" />
          {t("admin:adminOms.fulfillmentRecovery.preview")}
        </Button>
        {safeBySnapshot && safeCandidate ? (
          <Button
            type="button"
            size="sm"
            data-testid="admin-oms-recovery-execute"
            disabled={!accessToken || isPending || state.status === "executing" || state.status === "done"}
            onClick={() => void execute()}
          >
            {t("admin:adminOms.fulfillmentRecovery.execute")}
          </Button>
        ) : null}
      </div>
    </DetailSection>
  );
}

function statusTone(status: OmsOrderDetail["fulfillmentHealth"]["healthStatus"]): "teal" | "bad" | "warn" {
  if (status === "ok") return "teal";
  if (["blocked_uncertain", "local_ahead", "provider_ahead"].includes(status)) return "bad";
  return "warn";
}

// Keeps the i18n fallback for non-Error rejections, but an Error now goes through
// the shared BFF formatter so the operator sees the provider support code -
// the local copy dropped it, which is exactly the code they need to quote.
function errorMessage(error: unknown, t: TFunction): string {
  return error instanceof Error ? bffErrorMessage(error) : t("admin:adminOms.toast.unknownError");
}
