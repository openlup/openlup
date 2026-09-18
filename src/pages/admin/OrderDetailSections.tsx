import type { Dispatch, SetStateAction } from "react";
import { Link } from "react-router-dom";
import { ClipboardList, UserRound } from "lucide-react";
import type { TFunction } from "i18next";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { ActionButton, DetailSection, InfoBlock } from "./OrderDetailBlocks";
import {
  type AddressDraft,
  confirmation,
  customerName,
  eligibilityReason,
  formatDate,
  formatMoney,
  isAddressDraftComplete,
} from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

// OrderActionKind is the shared action vocabulary for the detail sheet; ActionsSection
// (which consumes it) lives in ./OrderDetailActionsSection to keep this file bounded.
export type OrderActionKind = "note" | "hold" | "release" | "createFulfillment" | "updateAddress" | "label" | "handoff" | "tracking" | "cancel" | "markRefunded";

type MutableAddress = Dispatch<SetStateAction<AddressDraft>>;
export type TrackingStatus = "in_transit" | "delivered" | "exception";
export const TRACKING_STATUSES: TrackingStatus[] = ["in_transit", "delivered", "exception"];

export function OverviewSection({ detail, t }: { detail: OmsOrderDetail; t: TFunction }) {
  return (
    <section className="grid gap-3 md:grid-cols-2">
      <InfoBlock label={t("admin:adminOms.detail.customer")} value={customerName(detail)} meta={detail.customer?.email ?? ""}>
        {/* The one hop the console was missing: without it an operator leaves the order,
            opens Customers and retypes an address by hand. `subject` is the customer-card
            deep link and `q` seeds the list behind it, so the sheet opens over a result
            set that explains itself instead of over an empty search. */}
        {detail.clientId ? (
          <Link
            to={`/admin/clients?${new URLSearchParams({ q: detail.customer?.email ?? detail.clientId, subject: detail.clientId })}`}
            data-testid="admin-oms-customer-card-link"
            className="focus-ring mt-2 inline-flex items-center gap-1 text-xs font-semibold text-teal hover:underline"
          >
            <UserRound size={14} aria-hidden="true" />
            {t("admin:adminOms.detail.openCustomerCard")}
          </Link>
        ) : null}
      </InfoBlock>
      <InfoBlock label={t("admin:adminOms.detail.pet")} value={detail.pet?.name ?? t("admin:adminOms.missing.pet")} meta={detail.pet?.breed ?? ""} />
      <InfoBlock label={t("admin:adminOms.detail.payment")} value={t(`admin:adminOms.paymentStatus.${detail.paymentStatus}`)} meta={detail.payment.providerPaymentId ?? ""} />
      <InfoBlock label={t("admin:adminOms.detail.accounting")} value={t(`admin:adminOms.accountingStatus.${detail.accounting.status}`)} meta={detail.accounting.invoiceRef ?? ""} />
    </section>
  );
}

export function AddressSection({
  detail,
  addressDraft,
  setAddressDraft,
  isPending,
  onAction,
  t,
}: {
  detail: OmsOrderDetail;
  addressDraft: AddressDraft;
  setAddressDraft: MutableAddress;
  isPending: boolean;
  onAction: (kind: OrderActionKind) => void;
  t: TFunction;
}) {
  const eligibility = detail.actionEligibility.updateShippingAddress;
  const hasRevisionedDeliveryContact = Boolean(
    detail.deliveryContact?.effective
      && detail.deliveryContact.revision !== null
      && detail.deliveryContact.digest !== null,
  );
  const disabledReason =
    (isPending ? t("admin:adminOms.eligibility.action_pending") : null) ??
    (!hasRevisionedDeliveryContact ? t("admin:adminOms.eligibility.delivery_contact_projection_required") : null) ??
    eligibilityReason(eligibility.reason, t) ??
    (!isAddressDraftComplete(addressDraft) ? t("admin:adminOms.eligibility.address_required_fields") : null);
  return (
    <DetailSection testId="admin-oms-address-section" title={t("admin:adminOms.detail.address")}>
      {!detail.deliveryContact?.effective && !detail.shippingAddress && <p className="mb-3 text-sm text-warm-amber">{t("admin:adminOms.missing.address")}</p>}
      {detail.deliveryContact ? (
        <div className="mb-3 grid gap-2 md:grid-cols-2" data-testid="admin-oms-delivery-contact-truth">
          <DeliveryContactTruth
            label={t("admin:adminOms.deliveryContact.baseline")}
            contact={detail.deliveryContact.baseline}
            t={t}
          />
          <DeliveryContactTruth
            label={t("admin:adminOms.deliveryContact.effective")}
            contact={detail.deliveryContact.effective}
            meta={t("admin:adminOms.deliveryContact.state", {
              source: detail.deliveryContact.source ?? "-",
              revision: detail.deliveryContact.revision ?? "-",
              state: detail.deliveryContact.frozen
                ? t("admin:adminOms.deliveryContact.frozen")
                : t("admin:adminOms.deliveryContact.correctable"),
              providerState: detail.deliveryContact.providerSubmissionState,
            })}
            t={t}
          />
        </div>
      ) : null}
      <p className="mb-3 text-xs text-text-muted" data-testid="admin-oms-delivery-contact-scope-note">
        {t("admin:adminOms.deliveryContact.scopeNote")}
      </p>
      <div className="grid gap-2 md:grid-cols-2">
        <AddressInput value={addressDraft.recipientName} field="recipientName" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.contactEmail} field="contactEmail" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.contactPhone} field="contactPhone" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.line1} field="line1" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.line2} field="line2" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.postalCode} field="postalCode" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.city} field="city" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressInput value={addressDraft.country} field="country" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
      </div>
      <div className="mt-2 grid gap-2 md:grid-cols-2">
        <AddressTextarea value={addressDraft.deliveryNotes} field="deliveryNotes" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
        <AddressTextarea value={addressDraft.courierInstructions} field="courierInstructions" setAddressDraft={setAddressDraft} disabled={isPending} t={t} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ActionButton
          icon={ClipboardList}
          label={t("admin:adminOms.actions.updateAddress")}
          hint={t("admin:adminOms.actions.hint.updateAddress")}
          testId="admin-oms-action-update-address"
          disabled={isPending || !hasRevisionedDeliveryContact || !eligibility.allowed || !isAddressDraftComplete(addressDraft)}
          disabledReason={disabledReason}
          confirm={confirmation(t)}
          onClick={() => onAction("updateAddress")}
        />
      </div>
    </DetailSection>
  );
}

function DeliveryContactTruth({
  label,
  contact,
  meta,
  t,
}: {
  label: string;
  contact: NonNullable<OmsOrderDetail["deliveryContact"]>["effective"];
  meta?: string;
  t: TFunction;
}) {
  return (
    <div className="rounded-lg border border-warm-sand bg-offwhite p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-teal">{label}</p>
      <p className="mt-1 text-sm text-teal-dark">
        {contact
          ? compactParts([
              contact.recipientName,
              contact.contactEmail,
              contact.contactPhone,
              compactParts([contact.line1, contact.line2, contact.postalCode, contact.city, contact.country]).join(", "),
            ]).join(" · ")
          : t("admin:adminOms.deliveryContact.missing")}
      </p>
      {meta ? <p className="mt-1 text-xs text-text-muted">{meta}</p> : null}
    </div>
  );
}

export function LinesSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  return (
    <DetailSection testId="admin-oms-lines-section" title={t("admin:adminOms.detail.lines")}>
      <div className="space-y-2">
        {detail.lines.map((line) => (
          <div key={line.id} className="flex items-center justify-between gap-3 text-sm">
            <div>
              <p className="font-medium text-teal-dark">{line.title ?? line.sku ?? line.id.slice(0, 8)}</p>
              <p className="text-xs text-text-muted">
                {compactParts([
                  line.sku ? t("admin:adminOms.detail.sku", { value: line.sku }) : null,
                  t("admin:adminOms.detail.quantity", { count: line.quantity }),
                  t("admin:adminOms.detail.unitPrice", { value: formatMoney(line.unitPrice, locale) }),
                  line.vatRateBps == null ? null : t("admin:adminOms.detail.vatRate", { value: formatVat(line.vatRateBps) }),
                ]).join(" · ")}
              </p>
            </div>
            <div className="text-right">
              <p className="font-medium text-teal-dark">
                {t("admin:adminOms.detail.effectiveGross", {
                  value: formatMoney(line.effectiveTotal, locale),
                })}
              </p>
              <p className="text-xs text-text-muted">
                {compactParts([
                  t("admin:adminOms.detail.catalogTotal", {
                    value: formatMoney(line.total, locale),
                  }),
                  t("admin:adminOms.detail.discountAllocated", {
                    value: formatMoney(line.discountAllocated, locale),
                  }),
                  t("admin:adminOms.detail.effectiveNet", {
                    value: formatMoney(line.effectiveNet, locale),
                  }),
                ]).join(" · ")}
              </p>
            </div>
          </div>
        ))}
      </div>
    </DetailSection>
  );
}

export function TimelineSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  return (
    <DetailSection testId="admin-oms-timeline" title={t("admin:adminOms.detail.timeline")}>
      <div className="space-y-3">
        {detail.operations.length === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noTimeline")}</p>
        ) : (
          detail.operations.map((operation) => (
            <div key={operation.id} className="border-l border-teal/40 pl-3">
              <p className="text-sm font-medium text-teal-dark">{t(`admin:adminOms.operation.${operation.type}`)}</p>
              <p className="text-xs text-text-muted">{formatDate(operation.occurredAt, locale)}</p>
              {operationSummary(operation.payload, t) && <p className="mt-1 text-sm text-text-muted">{operationSummary(operation.payload, t)}</p>}
            </div>
          ))
        )}
      </div>
    </DetailSection>
  );
}

function operationSummary(payload: Record<string, unknown>, t: TFunction): string {
  const address = isRecord(payload.address) ? payload.address : null;
  return compactParts([
    readText(payload, "note"),
    readText(payload, "reason"),
    readText(payload, "status"),
    readText(payload, "providerTrackingId"),
    readText(payload, "source"),
    address ? compactParts([readText(address, "city"), readText(address, "postalCode"), readText(address, "country")]).join(" ") : null,
    typeof payload.releasedReservationCount === "number"
      ? t("admin:adminOms.detail.releasedReservations", { count: payload.releasedReservationCount })
      : null,
  ]).join(" · ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatVat(value: number): string {
  return `${value / 100}%`;
}

function AddressInput({
  value,
  field,
  setAddressDraft,
  disabled,
  t,
}: {
  value: string;
  field: keyof AddressDraft;
  setAddressDraft: MutableAddress;
  disabled: boolean;
  t: TFunction;
}) {
  return (
    <Input
      type={field === "contactEmail" ? "email" : undefined}
      data-testid={`admin-oms-address-${field}`}
      value={value}
      onChange={(event) => setAddressDraft((draft) => ({ ...draft, [field]: event.target.value }))}
      placeholder={t(`admin:adminOms.address.${field}`)}
      aria-label={t(`admin:adminOms.address.${field}`)}
      disabled={disabled}
      className="border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
    />
  );
}

function AddressTextarea({
  value,
  field,
  setAddressDraft,
  disabled,
  t,
}: {
  value: string;
  field: keyof AddressDraft;
  setAddressDraft: MutableAddress;
  disabled: boolean;
  t: TFunction;
}) {
  return (
    <Textarea
      data-testid={`admin-oms-address-${field}`}
      value={value}
      onChange={(event) => setAddressDraft((draft) => ({ ...draft, [field]: event.target.value }))}
      placeholder={t(`admin:adminOms.address.${field}`)}
      aria-label={t(`admin:adminOms.address.${field}`)}
      disabled={disabled}
      className="min-h-20 border-warm-sand bg-offwhite text-teal-dark placeholder:text-text-muted"
    />
  );
}
