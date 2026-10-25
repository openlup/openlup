import type {
  AccountActionRequired,
  AccountSnapshot,
  AccountSubscription,
  AccountSubscriptionLine,
  AccountOrderSummary,
  AccountProfile
} from "./contracts/account.js";
import type { SubscriptionPaymentMethodStatus } from "./contracts/commands.js";

export const CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION = "customer.account.v3" as const;
type Row = Record<string, unknown>;

export interface CustomerSubscriptionEligibilityInput {
  subscriptionId: string;
  status: AccountSubscription["status"];
  nextCycleAt: string | null;
  editCutoffAt: string | null;
  paymentMethodKind: string | null;
  paymentMethodRefPresent: boolean;
  paymentMethodStatus?: SubscriptionPaymentMethodStatus;
}

export interface CustomerSubscriptionEligibility {
  canEdit: boolean;
  reason: AccountSubscription["editBlockedReason"]
}

export interface SubscriptionActionState {
  subscriptionId: string;
  orderId: string | null;
  blockedReason: AccountActionRequired["blockedReason"];
  failureCause: AccountActionRequired["failureCause"];
  recoveryEligible: boolean;
  dueAt: string | null;
  nextRetryAt: string | null;
}

export interface AccountReadSources<Extension, ChargeEvidence = AccountSubscription["nextCharge"], PaymentEvidence = unknown> {
  readExtension(clientId: string): Promise<Extension>;
  /** The selected store applies the bound BEFORE visibility filtering. */
  readSubscriptionRows(clientId: string, limit: number): Promise<Row[]>;
  readAddresses(clientId: string): Promise<AccountSnapshot["addresses"]>;
  readOrdererProfiles(clientId: string): Promise<AccountSnapshot["ordererProfiles"]>;
  readPaymentPreferences(clientId: string): Promise<AccountSnapshot["paymentPreferences"]>;
  readDeliveryPreferences(clientId: string): Promise<AccountSnapshot["deliveryPreferences"]>;
  readOrders(clientId: string, limit: number): Promise<{ orders: AccountOrderSummary[] }>;
  readEvents(clientId: string): Promise<AccountSnapshot["events"]>;
  readSubscriptionLines(ids: string[]): Promise<Map<string, AccountSubscriptionLine[]>>;
  readSubscriptionBlockers(
    ids: string[],
    nextCycles: Map<string, string | null>
  ): Promise<Map<string, NonNullable<AccountSubscription["editBlockedReason"]>>>;
  readPauseWindows(ids: string[]): Promise<Map<string, Pick<AccountSubscription, "pausePreset" | "pauseStartedAt" | "pauseEndsAt">>>;
  readPaymentEvidence(ids: string[]): Promise<Map<string, PaymentEvidence>>;
  /** Owner interprets M08 refusal; unsupported MUST throw, never return an empty Map. */
  readDeliveryAlignments(nextCycles: Map<string, string | null>): Promise<Map<string, { state: "protected" | "aligned" }>>;
  readNextCharges(rows: Row[]): Promise<Map<string, ChargeEvidence>>;
  readActionStates(ids: string[]): Promise<Map<string, SubscriptionActionState>>;
}

export interface AccountReadProjectionPolicy<ChargeEvidence = AccountSubscription["nextCharge"], PaymentEvidence = unknown> {
  paymentMethodStatus(
    input: { clientId: string; clientEmail: string | null; row: Row; evidence: PaymentEvidence | undefined }
  ): SubscriptionPaymentMethodStatus;
  canUsePaymentMethodForRenewal(status: SubscriptionPaymentMethodStatus): boolean;
  packageSummary(lines: AccountSubscriptionLine[], constraint: unknown): string | null;
  /** Pricing authority selects payable-cycle/acquisition shipping precedence. */
  withNextCharge(
    recurring: AccountSubscription["recurringPrice"],
    next: ChargeEvidence | undefined
  ): Pick<AccountSubscription, "recurringPrice" | "nextCharge">;
}

/** Two observation stages, including the original nested subscription fan-out. Auth/ownership precedes this call. */
export async function readAccountSnapshot<Extension, ChargeEvidence, PaymentEvidence>(
  sources: AccountReadSources<Extension, ChargeEvidence, PaymentEvidence>,
  policy: AccountReadProjectionPolicy<ChargeEvidence, PaymentEvidence>,
  client: Row
): Promise<AccountSnapshot<Extension>> {
  const clientId = text(client.id);
  const [extension, allRows, addresses, ordererProfiles, paymentPreferences, deliveryPreferences, orders, events] = await Promise.all([
    sources.readExtension(clientId),
    sources.readSubscriptionRows(clientId, 50),
    sources.readAddresses(clientId),
    sources.readOrdererProfiles(clientId),
    sources.readPaymentPreferences(clientId),
    sources.readDeliveryPreferences(clientId),
    sources.readOrders(clientId, 20),
    sources.readEvents(clientId),
  ]);
  const rows = allRows.filter(isCustomerVisibleSubscription);
  const ids = rows.map(row => text(row.id));
  const [subscriptions, states] = await Promise.all([
    assemble(sources, policy, rows, clientId, nullableText(client.email)),
    sources.readActionStates(ids),
  ]);
  return {
    contractVersion: CUSTOMER_ACCOUNT_V2_CONTRACT_VERSION,
    profile: profile(client),
    extension,
    subscriptions,
    addresses,
    ordererProfiles,
    billingProfiles: ordererProfiles,
    paymentPreferences,
    deliveryPreferences,
    recentOrders: orders.orders,
    events,
    actionRequired: buildActionRequired(subscriptions, orders.orders, states, policy.canUsePaymentMethodForRenewal)
  };
}

async function assemble<Extension, ChargeEvidence, PaymentEvidence>(
  sources: AccountReadSources<Extension, ChargeEvidence, PaymentEvidence>,
  policy: AccountReadProjectionPolicy<ChargeEvidence, PaymentEvidence>,
  rows: Row[],
  clientId: string,
  clientEmail: string | null
): Promise<AccountSubscription[]> {
  const ids = rows.map(row => text(row.id));
  const cycles = new Map(rows.map(row => [text(row.id), nullableText(row.next_cycle_at)]));
  const [lines, blockers, pauses, evidence, alignments, next] = await Promise.all([
    sources.readSubscriptionLines(ids),
    sources.readSubscriptionBlockers(ids, cycles),
    sources.readPauseWindows(ids),
    sources.readPaymentEvidence(ids),
    sources.readDeliveryAlignments(cycles),
    sources.readNextCharges(rows),
  ]);
  return rows.map(row => {
    const subscriptionId = text(row.id), status = text(row.status) as AccountSubscription["status"];
    const cutoff = editCutoff(
      nullableText(row.next_cycle_at),
      typeof row.edit_window_hours === "number" ? row.edit_window_hours : null
    );
    const paymentMethodStatus = policy.paymentMethodStatus({ clientId, clientEmail, row, evidence: evidence.get(subscriptionId) });
    const edit = computeEditState(
      {
        subscriptionId,
        status,
        nextCycleAt: nullableText(row.next_cycle_at),
        editCutoffAt: cutoff,
        paymentMethodKind: nullableText(row.payment_method_kind),
        paymentMethodRefPresent: Boolean(nullableText(row.payment_method_ref)),
        paymentMethodStatus
      },
      blockers,
      policy.canUsePaymentMethodForRenewal
    );
    const items = lines.get(subscriptionId) ?? [], pause = pauses.get(subscriptionId);
    return {
      subscriptionId,
      shippingAddressId: nullableText(row.shipping_address_id),
      status,
      pausePreset: pause?.pausePreset ?? null,
      pauseStartedAt: pause?.pauseStartedAt ?? null,
      pauseEndsAt: pause?.pauseEndsAt ?? null,
      cadenceDays: Number(row.cadence_days),
      nextCycleAt: nullableText(row.next_cycle_at),
      ...(alignments.has(subscriptionId) ? { deliveryAlignment: alignments.get(subscriptionId) } : {}),
      editCutoffAt: cutoff,
      canEditUpcomingPackage: edit.canEdit,
      editBlockedReason: edit.reason,
      paymentMethodKind: nullableText(row.payment_method_kind),
      paymentMethodStatus,
      templateVersion: Number(row.template_version),
      sizeConstraint: record(row.size_constraint),
      packageSummary: policy.packageSummary(items, row.size_constraint),
      ...policy.withNextCharge(recurringPrice(items), next.get(subscriptionId)),
      lines: items
    };
  });
}

export function isCustomerVisibleSubscription(row: Row): boolean {
  return ["active", "paused", "pending_activation"].includes(text(row.status))
    || (row.status === "cancelled" && row.cancellation_source === "customer_self_service");
}

export function recurringPrice(lines: AccountSubscriptionLine[]): AccountSubscription["recurringPrice"] {
  if (!lines.length) return null;
  let amount = 0, currency: string | null = null;
  for (const line of lines) {
    const money = line.lineSubtotal;
    if (typeof money?.amountMinor !== "number" || typeof money.currency !== "string"
      || (currency !== null && currency !== money.currency)) return null;
    currency = money.currency;
    amount += money.amountMinor;
  }
  if (currency === null) return null;
  return {
    subtotalGross: { amountMinor: amount, currency },
    totalGross: { amountMinor: amount, currency },
    currency,
    source: "frozen_quote_line"
  };
}

export function editCutoff(nextCycleAt: string | null, editWindowHours: number | null): string | null {
  if (!nextCycleAt) return null;
  const date = new Date(nextCycleAt);
  date.setHours(date.getHours() - (editWindowHours ?? 72));
  return date.toISOString();
}

export function computeEditState(
  input: CustomerSubscriptionEligibilityInput,
  blockers: ReadonlyMap<string, NonNullable<AccountSubscription["editBlockedReason"]>>,
  canUse: AccountReadProjectionPolicy["canUsePaymentMethodForRenewal"]
): CustomerSubscriptionEligibility {
  if (input.status !== "active") return { canEdit: false, reason: "not_active" };
  const reason = blockers.get(input.subscriptionId);
  if (reason) return { canEdit: false, reason };
  const usable = input.paymentMethodStatus
    ? canUse(input.paymentMethodStatus)
    : Boolean(input.paymentMethodKind && input.paymentMethodRefPresent);
  if (!usable) return { canEdit: false, reason: "missing_payment_method" };
  if (input.editCutoffAt && new Date(input.editCutoffAt).getTime() <= Date.now()) return { canEdit: false, reason: "edit_window_closed" };
  return { canEdit: true, reason: null };
}

export function buildActionRequired(
  subscriptions: AccountSubscription[],
  orders: AccountOrderSummary[],
  states = new Map<string, SubscriptionActionState>(),
  canUse: AccountReadProjectionPolicy["canUsePaymentMethodForRenewal"]
): AccountActionRequired[] {
  const actions: AccountActionRequired[] = [];
  for (const s of subscriptions) {
    const state = states.get(s.subscriptionId);
    const base = {
      entityType: "subscription" as const,
      entityId: s.subscriptionId,
      subscriptionId: s.subscriptionId,
      orderId: state?.orderId ?? null,
      failureCause: state?.failureCause ?? "unknown",
      dueAt: state?.dueAt ?? s.nextCycleAt,
      nextRetryAt: state?.nextRetryAt ?? null,
      recoveryEligible: state?.recoveryEligible ?? false
    };
    if (state?.blockedReason === "subscription_activation_missing_mandate") {
      actions.push({
        ...base,
        actionId: `subscription:${s.subscriptionId}:activation_missing_mandate`,
        kind: "payment_method_missing",
        severity: "critical",
        messageCode: "subscription_activation_missing_mandate",
        blockedReason: "subscription_activation_missing_mandate",
        failureCause: "unknown",
        title: "First order paid, subscription needs a payment method",
        body: "The first order is paid. Add a card to enable future renewals without charging that order again.",
        cta: "repair_payment",
        recoveryEligible: false,
        dueAt: state.dueAt,
        nextRetryAt: null
      });
      continue;
    }
    if (s.status !== "active" && s.status !== "paused") continue;
    if (state?.blockedReason === "payment_expired") {
      actions.push({
        ...base,
        actionId: `subscription:${s.subscriptionId}:payment_expired`,
        kind: "payment_recovery",
        severity: "critical",
        messageCode: "payment_expired",
        blockedReason: "payment_expired",
        title: "Subscription paused after payment could not be collected",
        body: "Every retry has been used, so nothing else will be attempted. Update the payment method to resume; the unpaid cycle is skipped and a new one starts from the resume date.",
        cta: "repair_payment",
        dueAt: state.dueAt,
        nextRetryAt: null
      });
      continue;
    }
    if (state) {
      actions.push({
        ...base,
        actionId: `subscription:${s.subscriptionId}:payment_blocked`,
        kind: state.recoveryEligible ? "payment_recovery" : "subscription_blocked",
        severity: "critical",
        messageCode: state.blockedReason ?? "payment_blocked",
        blockedReason: state.blockedReason,
        title: "Payment needs attention",
        body: state.recoveryEligible
          ? "Your subscription is blocked until the payment method is recovered."
          : "Your subscription has a payment issue that needs support review.",
        cta: state.recoveryEligible ? "repair_payment" : "contact_support"
      });
      continue;
    }
    if (!(s.paymentMethodStatus ? canUse(s.paymentMethodStatus) : Boolean(s.paymentMethodKind))) actions.push({
      ...base,
      actionId: `subscription:${s.subscriptionId}:payment_method_missing`,
      kind: "payment_method_missing",
      severity: "warning",
      messageCode: "missing_payment_method",
      blockedReason: "missing_payment_method",
      title: "Payment method missing",
      body: "Add or recover a payment method before the next subscription cycle.",
      cta: "contact_support"
    });
  }
  for (const order of orders) {
    const status = order.paymentStatus?.toLowerCase() ?? "",
      failed = ["failed", "payment_failed", "requires_payment_method"].includes(status),
      required = ["requires_action", "requires_confirmation"].includes(status);
    if (failed || required) actions.push({
      actionId: `order:${order.orderId}:${required ? "requires_action" : "payment_failed"}`,
      kind: "order_attention",
      severity: "critical",
      entityType: "order",
      entityId: order.orderId,
      subscriptionId: null,
      orderId: order.orderId,
      messageCode: required ? "payment_requires_action" : "payment_failed",
      blockedReason: required ? "payment_requires_action" : "payment_failed",
      failureCause: "unknown",
      title: required ? "Payment requires action" : "Payment failed",
      body: "Open the order details to review the payment status and next step.",
      cta: "view_order",
      recoveryEligible: false,
      dueAt: order.updatedAt,
      nextRetryAt: null
    });
    const invoice = order.invoice;
    if (invoice && !invoice.downloadAvailable && ["issued", "accepted"].includes(invoice.status)) actions.push({
      actionId: `invoice:${invoice.invoiceId}:pdf_unavailable`,
      kind: "invoice_attention",
      severity: "info",
      entityType: "invoice",
      entityId: invoice.invoiceId,
      subscriptionId: null,
      orderId: order.orderId,
      messageCode: "invoice_pdf_unavailable",
      blockedReason: "invoice_pdf_unavailable",
      failureCause: "unknown",
      title: "Invoice PDF unavailable",
      body: "The invoice is visible, but the PDF cannot be downloaded from the account yet.",
      cta: "contact_support",
      recoveryEligible: false,
      dueAt: invoice.issuedAt ?? invoice.createdAt,
      nextRetryAt: null
    });
  }
  return actions.slice(0, 8);
}

function profile(row: Row): AccountProfile {
  return {
    clientId: text(row.id),
    email: text(row.email),
    firstName: nullableText(row.first_name),
    lastName: nullableText(row.last_name),
    phone: nullableText(row.phone),
    lifecycleStage: text(row.lifecycle_stage) as AccountProfile["lifecycleStage"]
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function record(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
