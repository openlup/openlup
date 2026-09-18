import type { TFunction } from "i18next";
import type {
  OmsOrderDetail,
  AdminOmsOrderListItem,
} from "@/domains/commerce/omsContracts";
import { phaseIndexForStep } from "@/domains/fulfillment/statusMap";
import { formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { validateEmailField } from "@/lib/schemas/fields";

export const PAGE_SIZE = 25;

export type OperatorPipelineStage = {
  key: "payment" | "inventory" | "fulfillment" | "transit" | "delivered";
  complete: boolean;
  active: boolean;
  blocked: boolean;
};

export function operatorPipelineStages(
  order: Pick<AdminOmsOrderListItem, "paymentStatus" | "inventoryStatus" | "customerFulfillmentStep">,
): OperatorPipelineStage[] {
  const customerStep = order.customerFulfillmentStep;
  const phase = phaseIndexForStep(customerStep);
  const onTrack = customerStep !== "exception" && customerStep !== "cancelled";
  return [
    { key: "payment", complete: order.paymentStatus === "succeeded", active: order.paymentStatus !== "succeeded", blocked: order.paymentStatus === "failed" },
    { key: "inventory", complete: order.inventoryStatus === "reserved" || order.inventoryStatus === "consumed", active: order.inventoryStatus === "review_required", blocked: order.inventoryStatus === "missing" },
    { key: "fulfillment", complete: onTrack && phase >= phaseIndexForStep("transit"), active: onTrack && phase >= phaseIndexForStep("accepted") && phase < phaseIndexForStep("transit"), blocked: customerStep === "exception" },
    { key: "transit", complete: customerStep === "delivered", active: customerStep === "transit", blocked: false },
    { key: "delivered", complete: customerStep === "delivered", active: false, blocked: false },
  ];
}

export type AddressDraft = {
  recipientName: string;
  contactEmail: string;
  line1: string;
  line2: string;
  city: string;
  postalCode: string;
  country: string;
  contactPhone: string;
  deliveryNotes: string;
  courierInstructions: string;
};

export const EMPTY_ADDRESS_DRAFT: AddressDraft = {
  recipientName: "",
  contactEmail: "",
  line1: "",
  line2: "",
  city: "",
  postalCode: "",
  country: "PL",
  contactPhone: "",
  deliveryNotes: "",
  courierInstructions: "",
};

export function customerName(order: Pick<AdminOmsOrderListItem, "customer">): string {
  const name = [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(" ").trim();
  return name || order.customer?.email || "-";
}

// Public, customer-facing order references look like `OPENLUP-XXXXXXXX` (see the
// commerce_order_number_from_id() DB function). Synthetic preview/smoke fixtures
// instead carry internal slugs as their order_number (e.g.
// `HP-OUTBOX-outbox-matrix-…` / `HP-ACC-customer-account-fixture-…`), and a row
// could in theory carry a raw UUID. The operator UI must never surface those raw
// internal identifiers as the visible order number: when the stored order_number
// is an internal slug/UUID we fall back to a deterministic `OPENLUP-<first 8 hex of
// id>` derived from the order id (identical to the DB-side format).
const RAW_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Prefixes used only by synthetic preview/smoke fixtures, never by real orders.
const INTERNAL_SLUG_PREFIXES = ["HP-"];
// Real, human-facing order numbers are short; the synthetic slugs are long
// multi-segment strings well past this bound.
const MAX_PUBLIC_REF_LENGTH = 24;

function isInternalOrderRef(value: string): boolean {
  const upper = value.toUpperCase();
  if (upper.startsWith("OPENLUP-")) return false; // canonical public ref, always shown as-is
  if (RAW_UUID_PATTERN.test(value)) return true;
  if (INTERNAL_SLUG_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return value.length > MAX_PUBLIC_REF_LENGTH;
}

export function deriveOrderRefFromId(orderId: string): string {
  const hex = orderId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return hex ? `OPENLUP-${hex}` : "OPENLUP-UNKNOWN";
}

export function formatOperatorOrderRef(
  orderNumber: string | null | undefined,
  orderId: string | null | undefined,
): string {
  const trimmed = orderNumber?.trim();
  if (trimmed && !isInternalOrderRef(trimmed)) return trimmed;
  if (orderId) return deriveOrderRefFromId(orderId);
  return "OPENLUP-UNKNOWN";
}

/**
 * Formats an operator-facing amount in **the currency the amount itself carries**.
 *
 * The currency is required, and that is the whole point of the signature. It used
 * to be optional with a `?? "PLN"` behind it, which meant an amount whose payload
 * did not state a currency was *displayed as the platform default* - the silent
 * fallback programme decision R4 forbids, on the surface an operator uses to
 * check what a customer was charged. The fallback was never load-bearing either:
 * every caller passes money that `omsReadModelPricing.ts` and
 * `omsFirstSubscriptionPricePresentation.ts` stamped from `commerce_orders.currency`,
 * so the field has always been present and the default has always been dead code
 * wearing the shape of a decision.
 *
 * Requiring it moves the refusal to compile time. A value that is somehow empty at
 * runtime raises out of `Intl` rather than rendering an amount in a currency
 * nobody stated, which is the correct end of that trade for money.
 */
export function formatMoney(money: { amountMinor?: number; currency: string }, locale: string): string {
  return formatCurrencyMinor(money.amountMinor ?? 0, {
    currency: money.currency,
    locale: locale === "en" ? "en-US" : "pl-PL",
  });
}

export function formatDate(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "pl-PL", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

/**
 * Day-only sibling of `formatDate`, for values that are calendar days rather
 * than instants — currently the subscription delivery estimate.
 *
 * ⚠️ Deliberately has no time part. `estimateDeliveryWindow` anchors its output
 * at 12:00 in the dispatch policy's own zone precisely so a timezone-less `Intl`
 * call renders the intended calendar day for any realistic viewer; printing the
 * hour would surface that anchor as if it were a real dispatch time.
 */
export function formatDayShort(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale === "en" ? "en-US" : "pl-PL", {
    day: "2-digit",
    month: "short",
  }).format(new Date(value));
}

export function dateFiltersToIsoRange(fromDate: string, toDate: string): { from?: string; to?: string } {
  return {
    from: localDateToIso(fromDate, false),
    to: localDateToIso(toDate, true),
  };
}

export function addressDraftFromDetail(detail: OmsOrderDetail | null): AddressDraft {
  const contact = detail?.deliveryContact?.effective;
  const address = detail?.shippingAddress;
  if (!contact && !address) return EMPTY_ADDRESS_DRAFT;
  return {
    recipientName: contact?.recipientName ?? address?.recipientName ?? "",
    contactEmail: contact?.contactEmail ?? "",
    line1: contact?.line1 ?? address?.line1 ?? "",
    line2: contact?.line2 ?? address?.line2 ?? "",
    city: contact?.city ?? address?.city ?? "",
    postalCode: contact?.postalCode ?? address?.postalCode ?? "",
    country: contact?.country ?? address?.country ?? "PL",
    contactPhone: contact?.contactPhone ?? address?.contactPhone ?? "",
    deliveryNotes: contact?.deliveryInstructions ?? address?.deliveryNotes ?? "",
    courierInstructions: contact?.courierInstructions ?? address?.courierInstructions ?? "",
  };
}

export function isAddressDraftComplete(address: AddressDraft): boolean {
  const email = address.contactEmail.trim();
  return Boolean(
    address.recipientName.trim() &&
      validateEmailField(email, { required: true }).success &&
      address.contactPhone.trim() &&
      address.line1.trim() &&
      address.city.trim() &&
      address.postalCode.trim() &&
      address.country.trim(),
  );
}

export function confirmation(t: TFunction) {
  return {
    title: t("admin:adminOms.confirm.title"),
    description: t("admin:adminOms.confirm.description"),
    actionLabel: t("admin:adminOms.confirm.action"),
    cancelLabel: t("admin:adminOms.confirm.cancel"),
  };
}

export function markRefundedConfirmation(t: TFunction) {
  return { ...confirmation(t), description: t("admin:adminOms.confirm.markRefundedDescription") };
}

export function eligibilityReason(reason: string | null | undefined, t: TFunction) {
  if (!reason) return null;
  if (reason === "delivery_contact_submission_started") {
    return t("admin:adminOms.eligibility.delivery_contact_submission_started");
  }
  if (reason === "delivery_contact_stale_revision") {
    return t("admin:adminOms.eligibility.delivery_contact_stale_revision");
  }
  if (reason === "legacy_delivery_contact_read_only") {
    return t("admin:adminOms.eligibility.legacy_delivery_contact_read_only");
  }
  // A bounded lock wait expired: another writer held what this command needed and
  // it refused rather than hang. Spelled out like its neighbours above because the
  // fallback below builds its key from a variable, which no static reader can see,
  // and an operator reading "lock timeout" would not learn that pressing the
  // button again is exactly the right move.
  if (reason === "lock_timeout") {
    return t("admin:adminOms.eligibility.lock_timeout");
  }
  const key = `admin:adminOms.eligibility.${reason}`;
  const translated = t(key);
  return translated === key ? reason.replace(/_/g, " ") : translated;
}

function localDateToIso(value: string, endOfDay: boolean): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    endOfDay ? 23 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 59 : 0,
    endOfDay ? 999 : 0,
  );
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
