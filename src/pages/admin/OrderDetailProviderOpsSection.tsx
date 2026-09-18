import { CheckCircle2, CircleSlash, LinkIcon, Radio, Workflow } from "lucide-react";
import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import {
  FULFILLMENT_PROVIDER_CAPABILITY_KEYS,
  getFulfillmentProviderCapabilityProfile,
  type FulfillmentProviderCapabilityKey,
  type FulfillmentProviderCapabilityProfile,
} from "@/domains/fulfillment/providerCapabilities";
import { AdminStatusPill } from "@/components/admin/AdminSurface";
import { DetailSection, InfoBlock } from "./OrderDetailBlocks";
import { ProviderEvidence } from "./OrderDetailProviderEvidence";
import { ProviderOpsSla } from "./OrderDetailProviderOpsSla";
import { SelectedDeliveryBlock } from "./OrderDetailSelectedDeliveryBlock";
import { formatDate } from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

export function ProviderOpsSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  const references = detail.fulfillment.trackingReferences;
  const timeline = detail.fulfillment.trackingTimeline;
  const profile = getFulfillmentProviderCapabilityProfile(detail.fulfillment.providerKind);
  return (
    <DetailSection
      testId="admin-oms-provider-ops-section"
      title={t("admin:adminOms.detail.providerOps")}
      actions={(
        <AdminStatusPill tone="teal">
          {detail.fulfillment.providerKind ?? t("admin:adminOms.detail.providerPending")}
        </AdminStatusPill>
      )}
    >
      <ProviderOpsSla detail={detail} locale={locale} t={t} />
      <FulfillmentDebug detail={detail} t={t} />
      <div className="grid gap-3 md:grid-cols-2">
        <SelectedDeliveryBlock detail={detail} t={t} />
        <InfoBlock
          label={t("admin:adminOms.detail.carrier")}
          value={compactParts([detail.fulfillment.carrierKind, detail.fulfillment.service]).join(" / ") || t("admin:adminOms.detail.notAvailable")}
          meta={detail.fulfillment.trackingUrl ?? ""}
        />
        <InfoBlock
          label={t("admin:adminOms.detail.providerTracking")}
          value={detail.fulfillment.providerTrackingId ?? t("admin:adminOms.detail.notAvailable")}
          meta={detail.fulfillment.latestOperationAt ? formatDate(detail.fulfillment.latestOperationAt, locale) : ""}
        />
        <InfoBlock
          label={t("admin:adminOms.detail.providerOrderId")}
          value={detail.providerOrderId ?? t("admin:adminOms.detail.notAvailable")}
          meta={detail.providerOpsStatus !== "none" ? t(`admin:adminOms.providerOpsStatus.${detail.providerOpsStatus}`) : ""}
        />
      </div>
      <ProviderCapabilities profile={profile} t={t} />
      <TrackingReferences references={references} locale={locale} t={t} />
      <ProviderTimeline timeline={timeline} locale={locale} t={t} />
      <ProviderEvidence evidence={detail.fulfillment.providerEvidence ?? []} locale={locale} t={t} />
    </DetailSection>
  );
}

function FulfillmentDebug({ detail, t }: { detail: OmsOrderDetail; t: TFunction }) {
  const debug = detail.fulfillmentDebug;
  return (
    <div className="mb-4 rounded-md border border-teal/20 bg-teal/5 p-3" data-testid="admin-oms-fulfillment-debug">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.fulfillmentDebug")}</p>
          <p className="text-sm font-medium text-teal-dark">{debug.summary}</p>
        </div>
        <AdminStatusPill tone={debug.severity === "ok" ? "teal" : debug.severity === "watch" ? "warn" : "bad"}>
          {t(`admin:adminOms.fulfillmentDebugSeverity.${debug.severity}`)}
        </AdminStatusPill>
      </div>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {debug.steps.map((step) => (
          <div key={step.key} className="rounded-md border border-warm-sand bg-white p-2 text-sm">
            <p className="flex items-center justify-between gap-2 font-medium text-teal-dark">
              <span>{step.label}</span>
              <span className={debugStepClass(step.status)}>{t(`admin:adminOms.fulfillmentDebugStatus.${step.status}`)}</span>
            </p>
            <p className="mt-1 text-xs text-text-muted">{compactParts([step.value, ...step.details]).join(" · ") || t("admin:adminOms.detail.notAvailable")}</p>
          </div>
        ))}
      </div>
      {debug.blockers.length ? (
        <p className="mt-2 text-xs font-medium text-warm-coral">
          {t("admin:adminOms.detail.debugBlockers", { blockers: debug.blockers.join(", ") })}
        </p>
      ) : null}
    </div>
  );
}

function debugStepClass(status: OmsOrderDetail["fulfillmentDebug"]["steps"][number]["status"]): string {
  if (status === "ok") return "text-teal";
  if (status === "pending") return "text-warm-amber";
  return "text-warm-coral";
}

function ProviderCapabilities({ profile, t }: { profile: FulfillmentProviderCapabilityProfile | null; t: TFunction }) {
  const available = profile
    ? FULFILLMENT_PROVIDER_CAPABILITY_KEYS.filter((key) => profile.capabilities[key])
    : [];
  const unavailable = profile
    ? FULFILLMENT_PROVIDER_CAPABILITY_KEYS.filter((key) => !profile.capabilities[key])
    : [];
  return (
    <div className="mt-4 space-y-3" data-testid="admin-oms-provider-capabilities">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.providerCapabilities")}</span>
        {profile ? (
          <>
            <span className="rounded-full border border-teal/25 px-2 py-0.5 text-teal">
              {t(`admin:adminOms.providerRole.${profile.role}`)}
            </span>
            <span className="rounded-full border border-warm-sand px-2 py-0.5 text-text-muted">
              {t(`admin:adminOms.providerMutationSurface.${profile.actionPolicy.mutationSurface}`)}
            </span>
          </>
        ) : (
          <span className="text-text-muted">{t("admin:adminOms.detail.providerPending")}</span>
        )}
      </div>
      {profile ? (
        <>
          <CapabilityPills keys={available} enabled t={t} />
          <CapabilityPills keys={unavailable} enabled={false} t={t} />
          <ProviderActionPolicy profile={profile} t={t} />
        </>
      ) : null}
    </div>
  );
}

function CapabilityPills({
  keys,
  enabled,
  t,
}: {
  keys: FulfillmentProviderCapabilityKey[];
  enabled: boolean;
  t: TFunction;
}) {
  if (keys.length === 0) return null;
  const Icon = enabled ? CheckCircle2 : CircleSlash;
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((key) => (
        <span
          key={key}
          className={[
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
            enabled ? "border-teal/25 text-teal" : "border-warm-sand text-text-muted",
          ].join(" ")}
        >
          <Icon className="size-3" aria-hidden="true" />
          {t(`admin:adminOms.providerCapability.${key}`)}
        </span>
      ))}
    </div>
  );
}

function ProviderActionPolicy({
  profile,
  t,
}: {
  profile: FulfillmentProviderCapabilityProfile;
  t: TFunction;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 text-text-muted">
        <Workflow className="size-3" aria-hidden="true" />
        {t("admin:adminOms.detail.providerActions")}
      </span>
      <span className="rounded-full border border-warm-sand px-2 py-0.5 text-text-muted">
        {t(profile.actionPolicy.genericAdminActions
          ? "admin:adminOms.providerActionPolicy.generic"
          : "admin:adminOms.providerActionPolicy.noGeneric")}
      </span>
      <span className="rounded-full border border-warm-sand px-2 py-0.5 text-text-muted">
        {t(profile.actionPolicy.providerSpecificAdminActions
          ? "admin:adminOms.providerActionPolicy.providerSpecific"
          : "admin:adminOms.providerActionPolicy.noProviderSpecific")}
      </span>
    </div>
  );
}

function TrackingReferences({
  references,
  locale,
  t,
}: {
  references: OmsOrderDetail["fulfillment"]["trackingReferences"];
  locale: string;
  t: TFunction;
}) {
  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.trackingReferences")}</p>
      {references.length === 0 ? (
        <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noTrackingReferences")}</p>
      ) : references.map((reference) => (
        <div key={`${reference.providerKind}:${reference.trackingNumber}`} className="flex items-start gap-2 rounded-md border border-warm-sand bg-offwhite p-2 text-sm">
          <LinkIcon className="mt-0.5 size-4 shrink-0 text-teal" aria-hidden="true" />
          <div className="min-w-0">
            <p className="break-all font-medium text-teal-dark">{reference.trackingNumber}</p>
            <p className="text-xs text-text-muted">
              {compactParts([
                reference.providerKind,
                reference.carrierKind,
                reference.service,
                reference.updatedAt ? formatDate(reference.updatedAt, locale) : null,
              ]).join(" · ")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderTimeline({
  timeline,
  locale,
  t,
}: {
  timeline: OmsOrderDetail["fulfillment"]["trackingTimeline"];
  locale: string;
  t: TFunction;
}) {
  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.providerTimeline")}</p>
      {timeline.length === 0 ? (
        <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noProviderTimeline")}</p>
      ) : timeline.slice(0, 5).map((event) => (
        <div key={`${event.source}:${event.eventType}:${event.occurredAt ?? "pending"}`} className="flex items-start gap-2 text-sm">
          <Radio className="mt-0.5 size-4 shrink-0 text-warm-amber" aria-hidden="true" />
          <div>
            <p className="font-medium text-teal-dark">{event.label}</p>
            <p className="text-xs text-text-muted">
              {compactParts([
                event.eventType,
                event.source,
                event.occurredAt ? formatDate(event.occurredAt, locale) : null,
              ]).join(" · ")}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
