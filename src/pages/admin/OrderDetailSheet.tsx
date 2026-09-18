import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import {
  addAdminCommerceOrderNote,
  createAdminCommerceOrderHold,
  executeAdminPaidFulfillmentRecovery,
  getAdminCommerceOrderDetail,
  markAdminCommerceOrderRefundedManual,
  previewAdminPaidFulfillmentRecovery,
  releaseAdminCommerceOrderHold,
  generateAdminCommerceOrderPaymentLink,
  requestAdminCommerceOrderReplacementShipment,
  updateAdminCommerceOrderShippingAddress,
} from "@/domains/commerce/omsClient";
import {
  cancelAdminCommerceFulfillmentOrder,
  createAdminCommerceFulfillmentOrder,
  handOffAdminCommerceFulfillmentOrder,
  recordAdminCommerceFulfillmentLabel,
  recordAdminCommerceFulfillmentTrackingEvent,
} from "@/domains/fulfillment/commerceFulfillmentClient";
import type { AdminOmsOrderListItem } from "@/domains/commerce/omsContracts";
import { getAdminOmsFulfillmentProviderKind } from "@/lib/adminOmsFulfillmentProvider";
import { isBlockingVisibleQueryError, visibleFulfillmentRefreshInterval } from "@/domains/fulfillment/types";
import { AdminOmsErrorState } from "./AdminOmsErrorState";
import { type OrderActionKind } from "./OrderDetailSections";
import { OrderDetailSheetContent } from "./OrderDetailSheetContent";
import { useOrderActionDrafts } from "./useOrderActionDrafts";
import { addressDraftFromDetail, formatOperatorOrderRef } from "./ordersPageUtils";
import { actionFingerprint, actionTargetId, normalizeAddressDraft, type ActionKeySlot, type ActionMutationVariables } from "./orderDetailActionUtils";
export function OrderDetailSheet({ order, orderId, accessToken, locale, onClose }: {
  order: AdminOmsOrderListItem | null;
  orderId: string | null;
  accessToken: string | undefined;
  locale: string;
  onClose: () => void;
}) {
  const { t } = useTranslation("admin");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { drafts, setDraft, reset: resetDrafts } = useOrderActionDrafts();
  const actionKeysRef = useRef(new Map<string, ActionKeySlot>());
  const actionKeyCounterRef = useRef(0);
  const actionInFlightRef = useRef(false);
  const fulfillmentProviderKind = getAdminOmsFulfillmentProviderKind();
  const detailQuery = useQuery({
    queryKey: ["admin-oms-order-detail", orderId, accessToken],
    enabled: Boolean(orderId && accessToken),
    queryFn: async () => {
      if (!accessToken || !orderId) throw new Error("Admin session required");
      return getAdminCommerceOrderDetail(accessToken, orderId);
    },
    refetchInterval: (query) => visibleFulfillmentRefreshInterval([
      query.state.data?.order.fulfillment.status,
    ]),
    refetchOnWindowFocus: "always",
    retry: false,
  });
  const detail = detailQuery.data?.order ?? null;

  // The shipping-address draft mirrors the order, so it is re-seeded from the refetched
  // detail rather than cleared by `resetDrafts` - see the note on TYPED_DRAFT_RESET.
  useEffect(() => {
    setDraft("addressDraft", addressDraftFromDetail(detail));
  }, [detail, setDraft]);

  useEffect(() => {
    actionKeysRef.current.clear();
    actionKeyCounterRef.current = 0;
  }, [orderId]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ["admin-oms-orders"] });
    await queryClient.invalidateQueries({ queryKey: ["admin-oms-order-detail", orderId] });
    await queryClient.invalidateQueries({ queryKey: ["admin-accounting-order-summary"] });
  };

  const runAction = useMutation({
    mutationFn: async ({ kind, idempotencyKey }: ActionMutationVariables) => {
      if (!accessToken || !detail) throw new Error("Admin session required");
      if (kind === "updateAddress") {
        if (!detail.deliveryContact?.effective
          || detail.deliveryContact.revision === null
          || detail.deliveryContact.digest === null) {
          throw new Error("Delivery contact projection with revision and digest is required");
        }
        return updateAdminCommerceOrderShippingAddress(accessToken, {
          idempotencyKey,
          orderId: detail.orderId,
          expectedRevision: detail.deliveryContact.revision,
          expectedContactDigest: detail.deliveryContact.digest,
          address: normalizeAddressDraft(drafts.addressDraft),
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "note") {
        return addAdminCommerceOrderNote(accessToken, {
          idempotencyKey,
          orderId: detail.orderId,
          note: drafts.note.trim(),
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "hold") {
        return createAdminCommerceOrderHold(accessToken, {
          idempotencyKey,
          orderId: detail.orderId,
          reason: "manual_support",
          note: drafts.note.trim() || undefined,
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "release") {
        const holdId = detail.holds.find((hold) => hold.status === "active")?.id;
        if (!holdId) throw new Error("No active hold");
        return releaseAdminCommerceOrderHold(accessToken, {
          idempotencyKey,
          holdId,
          note: drafts.note.trim() || undefined,
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "createFulfillment") {
        return createAdminCommerceFulfillmentOrder(accessToken, {
          idempotencyKey,
          orderId: detail.orderId,
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "markRefunded") {
        return markAdminCommerceOrderRefundedManual(accessToken, {
          idempotencyKey,
          orderId: detail.orderId,
          reason: drafts.markRefundedReason.trim(),
          metadata: { source: "admin_oms_ui" },
        });
      }
      const fulfillmentOrderId = detail.fulfillment.fulfillmentOrderId;
      if (!fulfillmentOrderId) throw new Error("No fulfillment order");
      if (kind === "label") {
        if (!fulfillmentProviderKind) throw new Error("Admin OMS fulfillment provider is not configured");
        return recordAdminCommerceFulfillmentLabel(accessToken, {
          idempotencyKey,
          fulfillmentOrderId,
          providerKind: fulfillmentProviderKind,
          providerTrackingId: drafts.labelTrackingId.trim(),
          rawProviderPayload: {},
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "handoff") {
        return handOffAdminCommerceFulfillmentOrder(accessToken, {
          idempotencyKey,
          fulfillmentOrderId,
          metadata: { source: "admin_oms_ui" },
        });
      }
      if (kind === "tracking") {
        return recordAdminCommerceFulfillmentTrackingEvent(accessToken, {
          idempotencyKey,
          fulfillmentOrderId,
          status: drafts.trackingStatus,
          providerTrackingId: detail.fulfillment.providerTrackingId ?? undefined,
          rawEvent: {},
          metadata: { source: "admin_oms_ui" },
        });
      }
      return cancelAdminCommerceFulfillmentOrder(accessToken, {
        idempotencyKey,
        fulfillmentOrderId,
        reason: drafts.cancelReason.trim(),
        metadata: { source: "admin_oms_ui" },
      });
    },
    onSuccess: async (_data, variables) => {
      actionKeysRef.current.delete(variables.slotKey);
      resetDrafts();
      await invalidate();
      toast({ title: t("admin:adminOms.toast.success") });
    },
    onError: (error, variables) => {
      if (variables.kind === "updateAddress") void detailQuery.refetch();
      toast({
        title: t("admin:adminOms.toast.error"),
        description: error instanceof Error ? error.message : t("admin:adminOms.toast.unknownError"),
        variant: "destructive",
      });
    },
    onSettled: () => {
      actionInFlightRef.current = false;
    },
  });

  const actionDescriptor = (kind: OrderActionKind): ActionMutationVariables | null => {
    if (!detail) return null;
    const targetId = actionTargetId(kind, detail);
    // Content-addressed, not identity-addressed: the fingerprint below is compared
    // against the stored slot to decide whether to REUSE the idempotency key, so the
    // drafts must be read by value. Holding them in one object instead of six means a
    // keystroke in any field produces a new bag, and an identity-based fingerprint
    // would mint a fresh key on every render - see useOrderActionDrafts.test.tsx.
    const fingerprint = actionFingerprint(kind, detail, { ...drafts, fulfillmentProviderKind });
    const slotKey = `${targetId}:${kind}`;
    const existing = actionKeysRef.current.get(slotKey);
    if (existing?.fingerprint === fingerprint) {
      return { kind, idempotencyKey: existing.key, slotKey };
    }
    actionKeyCounterRef.current += 1;
    const key = [
      "admin-oms",
      targetId.slice(0, 8),
      kind,
      Date.now().toString(36),
      actionKeyCounterRef.current.toString(36),
    ].join(":");
    actionKeysRef.current.set(slotKey, { fingerprint, key });
    return { kind, idempotencyKey: key, slotKey };
  };

  const handleAction = (kind: OrderActionKind) => {
    if (runAction.isPending || actionInFlightRef.current) return;
    const descriptor = actionDescriptor(kind);
    if (!descriptor) return;
    actionInFlightRef.current = true;
    runAction.mutate(descriptor);
  };

  return (
    <Sheet open={Boolean(orderId)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent data-testid="admin-oms-detail-sheet" className="w-full overflow-y-auto border-warm-sand bg-white text-teal-dark sm:max-w-2xl">
        <SheetHeader className="mb-5">
          <p className="label-text text-teal">{t("admin:adminOms.detail.preview")}</p>
          <SheetTitle className="font-display text-xl text-teal-dark">
            {formatOperatorOrderRef(order?.orderNumber, order?.orderId ?? orderId)}
          </SheetTitle>
        </SheetHeader>

        {detailQuery.isLoading ? (
          <div className="py-12 text-center text-text-muted">
            <Loader2 className="mx-auto mb-2 animate-spin" size={20} />
            {t("admin:adminOms.loading")}
          </div>
        ) : isBlockingVisibleQueryError(detailQuery.isError, detail) ? (
          <AdminOmsErrorState
            testId="admin-oms-detail-error"
            title={t("admin:adminOms.errors.detailTitle")}
            description={t("admin:adminOms.errors.detailDescription")}
            retryLabel={t("admin:adminOms.errors.retry")}
            retrying={detailQuery.isFetching}
            onRetry={() => {
              void detailQuery.refetch();
            }}
          />
        ) : detail ? (
          <OrderDetailSheetContent
            accessToken={accessToken}
            detail={detail}
            drafts={drafts}
            executeRecovery={executeAdminPaidFulfillmentRecovery}
            fulfillmentProviderKind={fulfillmentProviderKind}
            isPending={runAction.isPending}
            locale={locale}
            onAction={handleAction}
            onRecovered={invalidate}
            previewRecovery={previewAdminPaidFulfillmentRecovery}
            generatePaymentLink={generateAdminCommerceOrderPaymentLink}
            requestReplacement={requestAdminCommerceOrderReplacementShipment}
            setDraft={setDraft}
            t={t}
          />
        ) : (
          <p className="text-sm text-text-muted">{t("admin:adminOms.detail.notFound")}</p>
        )}
      </SheetContent>
    </Sheet>
  );
}
