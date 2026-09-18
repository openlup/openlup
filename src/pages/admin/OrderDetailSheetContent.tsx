import { Fragment, useCallback, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { BillingSection, InventoryFulfillmentSection, PaymentHistorySection, SubscriptionSection } from "./OrderDetailContextSections";
import { OrderDetailAccountingPanel } from "./OrderDetailAccountingPanel";
import { OrderDetailChannelPanel } from "./OrderDetailChannelPanel";
import { CommunicationSection } from "./OrderDetailCommunicationSection";
import { PricingSummarySection } from "./OrderDetailPricingSection";
import { ActionsSection } from "./OrderDetailActionsSection";
import {
  AddressSection,
  LinesSection,
  type OrderActionKind,
  OverviewSection,
  TimelineSection,
} from "./OrderDetailSections";
import { ChannelSourceSection } from "./OrderDetailChannelSourceSection";
import { ProviderOpsSection } from "./OrderDetailProviderOpsSection";
import {
  type ExecuteRecovery,
  OrderDetailFulfillmentRecoverySection,
  type PreviewRecovery,
} from "./OrderDetailFulfillmentRecoverySection";
import {
  OrderDetailReplacementSection,
  type RequestReplacementShipment,
} from "./OrderDetailReplacementSection";
import {
  type GeneratePaymentLink,
  OrderDetailPaymentLinkSection,
} from "./OrderDetailPaymentLinkSection";
import { ActiveHoldsSection, DetailPipeline, TopActionBar } from "./OrderDetailPipeline";
import type { AddressDraft } from "./ordersPageUtils";
import type { OrderActionDrafts, SetOrderActionDraft } from "./useOrderActionDrafts";

type PanelKey =
  | "pipeline"
  | "topActions"
  | "activeHolds"
  | "overview"
  | "channelSource"
  | "pricing"
  | "subscription"
  | "paymentHistory"
  | "inventoryFulfillment"
  | "providerOps"
  | "fulfillmentRecovery"
  | "replacement"
  | "paymentLink"
  | "billing"
  | "address"
  | "lines"
  | "accounting"
  | "channelOps"
  | "communication"
  | "actions"
  | "timeline";

// The twenty-one panels of the detail sheet, as six named clusters.
//
// ⛔ THE PANEL SEQUENCE IS UNCHANGED. Reading this array top to bottom gives exactly the
// order the flat list rendered in, because each cluster is a CONTIGUOUS run of it.
// Whether an operator chasing a stuck order should meet provider ops and fulfillment
// recovery before billing and line items is owner decision D-7, and it has not been
// made; the master plan records "group but keep relative order" as the default until it
// is. This array is the whole edit surface for that decision - moving a key, or a whole
// cluster, is the reorder; nothing below reads panel order any other way.
const PANEL_GROUPS: Array<{ titleKey: string; panels: PanelKey[] }> = [
  { titleKey: "status", panels: ["pipeline", "topActions", "activeHolds"] },
  // `paymentLink` is APPENDED to the commercial cluster for the same reason `replacement`
  // is appended below: no existing panel moves, so D-7 stays unmade. It sits directly after
  // the payment history because the operator who has just read that the payment never
  // completed is exactly the operator deciding to send the customer a fresh link.
  { titleKey: "commercial", panels: ["overview", "channelSource", "pricing", "subscription", "paymentHistory", "paymentLink"] },
  // `replacement` is APPENDED to the fulfillment cluster, not inserted: no existing panel
  // moves, so D-7 stays unmade. It sits beside recovery because an operator who has just
  // read that a parcel failed is exactly the operator deciding to send a second one.
  { titleKey: "fulfillment", panels: ["inventoryFulfillment", "providerOps", "fulfillmentRecovery", "replacement"] },
  { titleKey: "shipping", panels: ["billing", "address", "lines"] },
  { titleKey: "documents", panels: ["accounting", "channelOps", "communication"] },
  { titleKey: "actions", panels: ["actions", "timeline"] },
];

export function OrderDetailSheetContent({
  accessToken,
  detail,
  drafts,
  executeRecovery,
  fulfillmentProviderKind,
  isPending,
  locale,
  onAction,
  onRecovered,
  previewRecovery,
  generatePaymentLink,
  requestReplacement,
  setDraft,
  t,
}: {
  accessToken: string | undefined;
  detail: OmsOrderDetail;
  drafts: OrderActionDrafts;
  executeRecovery: ExecuteRecovery;
  fulfillmentProviderKind: string | null;
  isPending: boolean;
  locale: string;
  onAction: (kind: OrderActionKind) => void;
  onRecovered: () => Promise<void>;
  previewRecovery: PreviewRecovery;
  generatePaymentLink: GeneratePaymentLink;
  requestReplacement: RequestReplacementShipment;
  setDraft: SetOrderActionDraft;
  t: TFunction;
}) {
  // The address form speaks `Dispatch<SetStateAction<AddressDraft>>` and its fields use
  // the functional form, so the bag setter is adapted once here rather than at each field.
  const setAddressDraft = useCallback<Dispatch<SetStateAction<AddressDraft>>>(
    (value) => setDraft("addressDraft", value),
    [setDraft],
  );

  const panels: Record<PanelKey, ReactNode> = {
    pipeline: <DetailPipeline detail={detail} t={t} />,
    topActions: <TopActionBar detail={detail} isPending={isPending} onAction={onAction} t={t} />,
    activeHolds: <ActiveHoldsSection detail={detail} isPending={isPending} onAction={onAction} t={t} />,
    overview: <OverviewSection detail={detail} t={t} />,
    channelSource: <ChannelSourceSection detail={detail} t={t} />,
    pricing: <PricingSummarySection detail={detail} locale={locale} t={t} />,
    subscription: <SubscriptionSection detail={detail} locale={locale} t={t} />,
    paymentHistory: <PaymentHistorySection detail={detail} locale={locale} t={t} />,
    inventoryFulfillment: <InventoryFulfillmentSection detail={detail} locale={locale} t={t} />,
    providerOps: <ProviderOpsSection detail={detail} locale={locale} t={t} />,
    fulfillmentRecovery: (
      <OrderDetailFulfillmentRecoverySection
        accessToken={accessToken}
        detail={detail}
        isPending={isPending}
        onRecovered={onRecovered}
        previewRecovery={previewRecovery}
        executeRecovery={executeRecovery}
        t={t}
      />
    ),
    replacement: (
      <OrderDetailReplacementSection
        accessToken={accessToken}
        detail={detail}
        isPending={isPending}
        onRequested={onRecovered}
        requestReplacement={requestReplacement}
        t={t}
      />
    ),
    paymentLink: (
      <OrderDetailPaymentLinkSection
        accessToken={accessToken}
        detail={detail}
        generatePaymentLink={generatePaymentLink}
        isPending={isPending}
        locale={locale}
        t={t}
      />
    ),
    billing: <BillingSection detail={detail} t={t} />,
    address: (
      <AddressSection
        detail={detail}
        addressDraft={drafts.addressDraft}
        setAddressDraft={setAddressDraft}
        isPending={isPending}
        onAction={onAction}
        t={t}
      />
    ),
    lines: <LinesSection detail={detail} locale={locale} t={t} />,
    accounting: <OrderDetailAccountingPanel accessToken={accessToken} orderId={detail.orderId} locale={locale} t={t} />,
    channelOps: <OrderDetailChannelPanel accessToken={accessToken} orderId={detail.orderId} t={t} />,
    communication: <CommunicationSection detail={detail} locale={locale} t={t} />,
    actions: (
      <ActionsSection
        detail={detail}
        note={drafts.note}
        setNote={(value) => setDraft("note", value)}
        labelTrackingId={drafts.labelTrackingId}
        setLabelTrackingId={(value) => setDraft("labelTrackingId", value)}
        trackingStatus={drafts.trackingStatus}
        setTrackingStatus={(value) => setDraft("trackingStatus", value)}
        cancelReason={drafts.cancelReason}
        setCancelReason={(value) => setDraft("cancelReason", value)}
        markRefundedReason={drafts.markRefundedReason}
        setMarkRefundedReason={(value) => setDraft("markRefundedReason", value)}
        fulfillmentProviderKind={fulfillmentProviderKind}
        orderProviderKind={detail.fulfillment.providerKind}
        isPending={isPending}
        onAction={onAction}
        t={t}
      />
    ),
    timeline: <TimelineSection detail={detail} locale={locale} t={t} />,
  };

  return (
    <div className="space-y-6">
      {PANEL_GROUPS.map(({ titleKey, panels: keys }) => (
        <section key={titleKey} data-testid={`admin-oms-detail-group-${titleKey}`} className="space-y-5">
          <h2 className="label-text text-teal">{t(`admin:adminOms.detail.group.${titleKey}`)}</h2>
          {/* Fragment, not a wrapper element: several panels render null for an order
              that has no subscription / no sales channel / no channel ingest, and an
              empty wrapper would still take a `space-y-5` gap. */}
          {keys.map((key) => (
            <Fragment key={key}>{panels[key]}</Fragment>
          ))}
        </section>
      ))}
    </div>
  );
}
