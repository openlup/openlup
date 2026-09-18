import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
  type CustomerAccountV2Response,
} from "../../../src/domains/customers/accountV2Contracts.js";
import {
  canUsePaymentMethodForRenewal,
  type SubscriptionPaymentMethodStatus,
} from "../../../src/domains/subscription/contracts.js";
import type { CustomerAccountResponse } from "../../../src/domains/customers/selfServiceContracts.js";
import { readDeliveryPreferences, readEvents, readPaymentPreferences, readPets } from "../../domains/customers/customerSelfServiceReadModels.js";
import { readAddresses, readOrdererProfiles } from "../../domains/customers/customerSelfServiceAddressModels.js";
import { readCustomerOrderSummaries } from "./customerOrderHistoryReadModels.js";
import type { CustomerOrderHistoryReadStore } from "./customerOrderHistoryReadModels.js";
import type { CustomerAccountReadStore } from "../../domains/customers/customerSelfServiceReadModels.js";
import type { CustomerAddressReadStore } from "../../domains/customers/customerSelfServiceAddressModels.js";
import {
  buildActionRequired,
  readSubscriptionActionStates,
} from "./customerAccountActionRequiredReadModel.js";
import { readSubscriptionLines } from "./customerAccountSubscriptionLinesReadModel.js";
import {
  readSubscriptionPaymentMethodEvidence,
  resolveCustomerSubscriptionPaymentMethodStatus,
} from "./customerSubscriptionPaymentMethodReadModel.js";
import {
  readSubscriptionBlockers,
  type CustomerSubscriptionEditBlockedReason,
} from "./customerSubscriptionBlockersReadModel.js";
import { readSubscriptionDeliveryAlignments, type DeliveryAlignmentRowsReader } from "../../domains/customers/customerSubscriptionDeliveryAlignmentReadModel.js";

type Row = Record<string, unknown>;
type Subscription = CustomerAccountV2Response["subscriptions"][number];
export type EditBlockedReason = NonNullable<Subscription["editBlockedReason"]>;
export { readSubscriptionBlockers } from "./customerSubscriptionBlockersReadModel.js";

export type CustomerSubscriptionEligibilityInput = {
  subscriptionId: string;
  status: Subscription["status"];
  nextCycleAt: string | null;
  editCutoffAt: string | null;
  paymentMethodKind: string | null;
  paymentMethodRefPresent: boolean;
  paymentMethodStatus?: SubscriptionPaymentMethodStatus;
};

export type CustomerSubscriptionEligibility = {
  canEdit: boolean;
  reason: Subscription["editBlockedReason"];
};

export async function readCustomerAccountV2(
  customerClient: SupabaseClient,
  serviceClient: SupabaseClient,
  accountStore: CustomerAccountReadStore & CustomerAddressReadStore,
  orderStore: CustomerOrderHistoryReadStore,
  client: Row,
  readDeliveryAlignmentRows?: DeliveryAlignmentRowsReader,
): Promise<CustomerAccountV2Response> {
  // Fan-out 1: reads that don't need the subscription id list, plus base subscription
  // rows. Subscription-scoped reads run in fan-out 2 (parallel, not serial-after).
  const [pets, subscriptionRows, addresses, ordererProfiles, preferences, deliveryPreferences, orders, events] = await Promise.all([
      readPets(accountStore, text(client.id)),
      readSubscriptionRows(customerClient, text(client.id)),
      readAddresses(accountStore, text(client.id)),
      readOrdererProfiles(accountStore, text(client.id)),
      readPaymentPreferences(accountStore, text(client.id)),
      readDeliveryPreferences(accountStore, text(client.id)),
      readCustomerOrderSummaries(orderStore, text(client.id), 20),
      readEvents(accountStore, text(client.id)),
    ]);
  const subscriptionIds = subscriptionRows.map((row) => text(row.id));
  // Fan-out 2: assemble subscriptions in parallel with the action-state read.
  const [subscriptions, subscriptionActionStates] = await Promise.all([
    assembleSubscriptions(serviceClient, subscriptionRows, text(client.id), nullableText(client.email), readDeliveryAlignmentRows),
    readSubscriptionActionStates(serviceClient, subscriptionIds),
  ]);
  return {
    contractVersion: CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
    profile: mapProfile(client),
    pets,
    subscriptions,
    addresses,
    ordererProfiles,
    billingProfiles: ordererProfiles,
    paymentPreferences: preferences,
    deliveryPreferences,
    recentOrders: orders.orders,
    events,
    actionRequired: buildActionRequired(subscriptions, orders.orders, subscriptionActionStates),
  };
}

async function readSubscriptionRows(customerClient: SupabaseClient, clientId: string): Promise<Row[]> {
  const { data, error } = await customerClient
    .from("subscriptions")
    .select("id, pet_id, shipping_address_id, status, cancellation_source, cadence_days, next_cycle_at, edit_window_hours, payment_method_kind, payment_method_ref, template_version, size_constraint")
    .eq("client_id", clientId)
    .order("created_at", { ascending: false })
    // Defensive bound: every per-subscription read fans out over this list. 50 is far
    // above any real account and caps the blast radius of accumulated
    // abandoned-checkout ghost subscriptions. The row set is then narrowed to the
    // customer-visible rule below, so the bound is applied before hiding, not after.
    .limit(50);
  if (error) throw error;
  return ((data ?? []) as Row[]).filter(isCustomerVisibleSubscription);
}

// Ghost rows (sweep-cancelled abandoned checkouts, terminally failed activations)
// are unrecoverable via self-service: reactivate requires a stored payment method
// these rows never had. Only positively customer-cancelled subscriptions keep the
// win-back "Wznow" path. pending_activation stays visible - it carries the
// complete-payment CTA and the paid-activation-gap actionRequired.
// activation_failed and completed are deliberately hidden.
// visible <=> status in {active, paused, pending_activation}
//         or (status = cancelled and cancellation_source = 'customer_self_service')
// `customer_self_service` is the fail-closed positive marker written by the
// self-service cancel path (migration 20260711170014); a NULL source means the
// row was cancelled by a system sweep and must stay hidden.
const CUSTOMER_VISIBLE_STATUSES = new Set(["active", "paused", "pending_activation"]);
export function isCustomerVisibleSubscription(row: Row): boolean {
  const status = text(row.status);
  if (CUSTOMER_VISIBLE_STATUSES.has(status)) return true;
  return status === "cancelled" && text(row.cancellation_source) === "customer_self_service";
}
async function assembleSubscriptions(
  serviceClient: SupabaseClient,
  rows: Row[],
  clientId: string,
  clientEmail: string | null,
  readDeliveryAlignmentRows?: DeliveryAlignmentRowsReader,
): Promise<Subscription[]> {
  const subscriptionIds = rows.map((row) => text(row.id));
  const nextCycleAtBySubscription = new Map(
    rows.map((row) => [text(row.id), nullableText(row.next_cycle_at)] as const),
  );
  const [lineMap, blockerMap, pauseWindowMap, paymentMethodMap, deliveryAlignmentMap] = await Promise.all([
    readSubscriptionLines(serviceClient, subscriptionIds),
    readSubscriptionBlockers(serviceClient, subscriptionIds, nextCycleAtBySubscription),
    readOpenPauseWindows(serviceClient, subscriptionIds),
    readSubscriptionPaymentMethodEvidence(serviceClient, subscriptionIds),
    readSubscriptionDeliveryAlignments(readDeliveryAlignmentRows, nextCycleAtBySubscription),
  ]);
  return rows.map((row) => {
    const editCutoffAt = editCutoff(nullableText(row.next_cycle_at), numberOrNull(row.edit_window_hours));
    const status = text(row.status) as Subscription["status"];
    const subscriptionId = text(row.id);
    const paymentEvidence = paymentMethodMap.get(subscriptionId);
    const paymentMethodStatus = resolveCustomerSubscriptionPaymentMethodStatus({
      clientId,
      clientEmail,
      subscriptionPaymentMethodKind: nullableText(row.payment_method_kind),
      subscriptionPaymentMethodRef: nullableText(row.payment_method_ref),
      paymentEvidence,
    });
    const editState = computeEditState(
      {
        subscriptionId,
        status,
        nextCycleAt: nullableText(row.next_cycle_at),
        editCutoffAt,
        paymentMethodKind: nullableText(row.payment_method_kind),
        paymentMethodRefPresent: Boolean(nullableText(row.payment_method_ref)),
        paymentMethodStatus,
      },
      blockerMap,
    );
    const lines = lineMap.get(text(row.id)) ?? [];
    const pauseWindow = pauseWindowMap.get(subscriptionId);
    return {
      subscriptionId,
      petId: nullableText(row.pet_id),
      shippingAddressId: nullableText(row.shipping_address_id),
      status,
      pausePreset: pauseWindow?.pausePreset ?? null,
      pauseStartedAt: pauseWindow?.pauseStartedAt ?? null,
      pauseEndsAt: pauseWindow?.pauseEndsAt ?? null,
      cadenceDays: Number(row.cadence_days),
      nextCycleAt: nullableText(row.next_cycle_at),
      ...(deliveryAlignmentMap.has(subscriptionId) ? { deliveryAlignment: deliveryAlignmentMap.get(subscriptionId) } : {}),
      editCutoffAt,
      canEditUpcomingPackage: editState.canEdit,
      editBlockedReason: editState.reason,
      paymentMethodKind: nullableText(row.payment_method_kind),
      paymentMethodStatus,
      templateVersion: Number(row.template_version),
      sizeConstraint: isRecord(row.size_constraint) ? row.size_constraint : null,
      packageSummary: packageSummary(lines, row.size_constraint),
      recurringPrice: recurringPrice(lines),
      lines,
    };
  });
}
async function readOpenPauseWindows(serviceClient: SupabaseClient, subscriptionIds: string[]) {
  const ids = Array.from(new Set(subscriptionIds.filter(Boolean)));
  const map = new Map<string, { pausePreset: Subscription["pausePreset"]; pauseStartedAt: string; pauseEndsAt: string | null }>();
  if (ids.length === 0) return map;
  const { data, error } = await serviceClient
    .from("subscription_pause_windows")
    .select("subscription_id, pause_preset, starts_at, ends_at")
    .in("subscription_id", ids)
    .is("resumed_at", null)
    .order("starts_at", { ascending: false });
  if (error) throw error;
  for (const row of (data ?? []) as Row[]) {
    const subscriptionId = text(row.subscription_id);
    if (!subscriptionId || map.has(subscriptionId)) continue;
    const pausePreset = text(row.pause_preset);
    map.set(subscriptionId, {
      pausePreset: pausePreset === "2_weeks" || pausePreset === "1_month" || pausePreset === "indefinite" ? pausePreset : null,
      pauseStartedAt: text(row.starts_at),
      pauseEndsAt: nullableText(row.ends_at),
    });
  }
  return map;
}

export function computeEditState(
  input: CustomerSubscriptionEligibilityInput,
  blockers: ReadonlyMap<string, CustomerSubscriptionEditBlockedReason> = new Map<string, CustomerSubscriptionEditBlockedReason>(),
): CustomerSubscriptionEligibility {
  if (input.status !== "active") return { canEdit: false, reason: "not_active" };

  const blocker = blockers.get(input.subscriptionId);
  if (blocker) return { canEdit: false, reason: blocker };

  const hasUsablePaymentMethod = input.paymentMethodStatus
    ? canUsePaymentMethodForRenewal(input.paymentMethodStatus)
    : Boolean(input.paymentMethodKind && input.paymentMethodRefPresent);
  if (!hasUsablePaymentMethod) {
    return { canEdit: false, reason: "missing_payment_method" };
  }

  if (input.editCutoffAt && new Date(input.editCutoffAt).getTime() <= Date.now()) {
    return { canEdit: false, reason: "edit_window_closed" };
  }

  return { canEdit: true, reason: null };
}

function packageSummary(lines: Subscription["lines"], sizeConstraint: unknown): string | null {
  const baseLines = lines.filter((line) => !line.isAddon);
  const addonCount = lines.filter((line) => line.isAddon).length;
  const pieces = [
    baseLines.length ? `${baseLines.length} recipe${baseLines.length === 1 ? "" : "s"}` : null,
    addonCount ? `${addonCount} add-on${addonCount === 1 ? "" : "s"}` : null,
    isRecord(sizeConstraint) && typeof sizeConstraint.packageSize === "string"
      ? sizeConstraint.packageSize
      : null,
  ];
  return pieces.filter(Boolean).join(" / ") || null;
}

export function recurringPrice(lines: Subscription["lines"]): Subscription["recurringPrice"] {
  // Fails closed on ANY unpriced line: renewal builds its charge from the same frozen
  // quoteLine metadata and throws per line when it is missing
  // (buildSubscriptionCycleSnapshots.ts extractQuoteLine), so a partial sum would show
  // a price the renewal engine would refuse to charge.
  //
  // The sum's currency is the LINES' currency, not the deployment's. This is the
  // number a customer is told they will next be charged, and it is built entirely out
  // of prices frozen when they agreed to them; asking a settlement profile what it
  // means would let a configuration change restate a standing agreement. Two lines in
  // different currencies are not summable at all - there is no rate here and inventing
  // one would be worse than the same "unpriced" answer an absent amount already gets.
  if (lines.length === 0) return null;
  let total = 0;
  let currency: string | null = null;
  for (const line of lines) {
    const amount = line.lineSubtotal?.amountMinor;
    const lineCurrency = line.lineSubtotal?.currency;
    if (typeof amount !== "number" || typeof lineCurrency !== "string") return null;
    if (currency !== null && currency !== lineCurrency) return null;
    currency = lineCurrency;
    total += amount;
  }
  if (currency === null) return null;
  return {
    subtotalGross: { amountMinor: total, currency },
    totalGross: { amountMinor: total, currency },
    currency,
    source: "frozen_quote_line",
  };
}

export function editCutoff(nextCycleAt: string | null, editWindowHours: number | null): string | null {
  if (!nextCycleAt) return null;
  const date = new Date(nextCycleAt);
  date.setHours(date.getHours() - (editWindowHours ?? 72));
  return date.toISOString();
}

function mapProfile(row: Row): CustomerAccountResponse["profile"] {
  return {
    clientId: text(row.id),
    email: text(row.email),
    firstName: nullableText(row.first_name),
    lastName: nullableText(row.last_name),
    phone: nullableText(row.phone),
    lifecycleStage: text(row.lifecycle_stage) as CustomerAccountResponse["profile"]["lifecycleStage"],
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Row {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
