import { expect, it, vi } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import {
  readAccountSnapshot,
  recurringPrice,
  computeEditState,
  editCutoff,
  isCustomerVisibleSubscription,
  buildActionRequired
} from "../../src/account-support/index.js";
import type {
  AccountReadSources,
  AccountReadProjectionPolicy,
  InvoiceOwnerAccessPort,
  InvoiceArtifactDownloadPort,
  SubscriptionActionState
} from "../../src/account-support/index.js";
import type { InvoiceHostPorts } from "../../src/invoicing/contracts/index.js";
import type { InvoiceAccessPort, AccountSubscriptionLine, AccountSubscription, AccountOrderSummary, AccountActionRequired } from "../../src/account-support/contracts/index.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
  : false;
type Assert<T extends true> = T;
export type PackagedOwnerEquality = [
  Assert<Equal<InvoiceAccessPort, InvoiceHostPorts["accountHistory"]>>,
  Assert<Equal<InvoiceOwnerAccessPort, InvoiceHostPorts["accountHistory"]>>,
  Assert<Equal<InvoiceArtifactDownloadPort, Pick<InvoiceHostPorts["artifacts"], "download">>>
];
const policy: AccountReadProjectionPolicy = {
  paymentMethodStatus: () => "usable",
  canUsePaymentMethodForRenewal: value => value === "usable",
  packageSummary: () => null,
  withNextCharge: (recurringPrice, nextCharge) => ({ recurringPrice, nextCharge })
};

function sources(): AccountReadSources<{ captured: boolean }> {
  return {
    readExtension: async () => ({ captured: true }),
    readSubscriptionRows: async () => [],
    readAddresses: async () => [],
    readOrdererProfiles: async () => [],
    readPaymentPreferences: async () => [],
    readDeliveryPreferences: async () => [],
    readOrders: async () => ({ orders: [] }),
    readEvents: async () => [],
    readSubscriptionLines: async () => new Map(),
    readSubscriptionBlockers: async () => new Map(),
    readPauseWindows: async () => new Map(),
    readPaymentEvidence: async () => new Map(),
    readDeliveryAlignments: async () => new Map(),
    readNextCharges: async () => new Map(),
    readActionStates: async () => new Map()
  };
}

it(
  "passes the 20/50 source bounds before visibility filtering and fans out assembly with action evidence",
  async () => {
    const input = sources(), trace: string[] = [];
    input.readSubscriptionRows = vi.fn(async () => [
      { id: "hidden", status: "cancelled" },
      { id: "visible", status: "active", cadence_days: 28, template_version: 2 }
    ]);
    const owned = Array.from(
      { length: 25 },
      (_, i) => ({
        orderId: `order-${i}`,
        orderRef: `order_${i}`,
        orderNumber: null,
        subscriptionId: null,
        status: "paid",
        paymentStatus: null,
        fulfillmentStatus: null,
        total: { amountMinor: i, currency: "EUR" },
        trackingNumber: null,
        trackingNumbers: [],
        trackingUrl: null,
        carrierKind: null,
        service: null,
        trackingReferences: [],
        trackingTimeline: [],
        deliverySelection: null,
        invoice: null,
        invoiceDocuments: [],
        invoiceRequestStatus: "not_requested" as const,
        createdAt: "2030-01-01",
        updatedAt: "2030-01-01"
      })
    );
    input.readOrders = vi.fn(async (_clientId, limit) => { trace.push("orders"); return { orders: owned.slice(0, limit) }; });
    input.readSubscriptionLines = vi.fn(async ids => { trace.push(`lines:${ids}`); return new Map(); });
    input.readActionStates = vi.fn(async ids => { trace.push(`actions:${ids}`); return new Map(); });
    const result = await readAccountSnapshot(input, policy, { id: "owned", email: "a@example.invalid", lifecycle_stage: "customer" });
    expect(input.readOrders).toHaveBeenCalledExactlyOnceWith("owned", 20);
    expect(input.readSubscriptionRows).toHaveBeenCalledExactlyOnceWith("owned", 50);
    expect(result.subscriptions.map(value => value.subscriptionId)).toEqual(["visible"]);
    expect(result.recentOrders).toHaveLength(20);
    expect(result.recentOrders.at(-1)?.orderId).toBe("order-19");
    expect(result.extension).toEqual({ captured: true });
    expect(result.billingProfiles).toBe(result.ordererProfiles);
    expect(trace).toEqual(["orders", "lines:visible", "actions:visible"]);
  }
);
const line: AccountSubscriptionLine = {
  lineId: "l", variantId: "v", qty: 1, sortOrder: 0, isAddon: false,
  title: null, sku: null, lineSubtotal: { amountMinor: 123, currency: "AAA" }
};
it.each([
  { name: "stored denomination", lines: [line], expected: { amountMinor: 123, currency: "AAA" } },
  { name: "missing money", lines: [line, { ...line, lineSubtotal: null }], expected: null },
  { name: "mixed denomination", lines: [line, { ...line, lineSubtotal: { amountMinor: 1, currency: "BBB" } }], expected: null }
])("retains frozen amounts: $name", ({ lines, expected }) => {
  const price = recurringPrice(lines);
  if (expected === null) expect(price).toBeNull();
  else expect(price?.totalGross).toEqual(expected);
});
it("leaves absent aggregate enrichment unknown", async () => {
  const result = await readAccountSnapshot(sources(), policy, { id: "a" });
  expect(result.actionRequired).toEqual([]);
});
it("propagates an aggregate source failure", async () => {
  const input = sources();
  input.readAddresses = async () => { throw new Error("read_failed"); };
  await expect(readAccountSnapshot(input, policy, { id: "owned" })).rejects.toThrow("read_failed");
});
it("checks packaged owner equality with the TypeScript checker", () => {
    const file = fileURLToPath(import.meta.url),
      program = ts.createProgram(
        [file],
        {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.NodeNext,
          moduleResolution: ts.ModuleResolutionKind.NodeNext,
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          allowImportingTsExtensions: true,
          types: ["node"]
        }
      );
    expect(ts.formatDiagnosticsWithColorAndContext(
      program.getSemanticDiagnostics(program.getSourceFile(file)!),
      { getCanonicalFileName: p => p, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" }
    )).toBe("");
  },
  30_000
);

it.each([
  { row: { status: "active" }, expected: true },
  { row: { status: "paused" }, expected: true },
  { row: { status: "pending_activation" }, expected: true },
  { row: { status: "cancelled", cancellation_source: "customer_self_service" }, expected: true },
  { row: { status: "activation_failed" }, expected: false }
])("retains visibility for $row.status", ({ row, expected }) => {
  expect(isCustomerVisibleSubscription(row)).toBe(expected);
});
it.each([
  { status: "active" as const, blocked: true, expected: "cycle_locked" },
  { status: "paused" as const, blocked: true, expected: "not_active" },
  { status: "active" as const, blocked: false, expected: "edit_window_closed" }
])("retains eligibility precedence: $status / blocked=$blocked", ({ status, blocked, expected }) => {
  expect(computeEditState({
    subscriptionId: "s", status, nextCycleAt: null, editCutoffAt: "2000-01-01T00:00:00Z",
    paymentMethodKind: "card", paymentMethodRefPresent: true
  }, blocked ? new Map([["s", "cycle_locked"]]) : new Map(), policy.canUsePaymentMethodForRenewal).reason).toBe(expected);
});
it.each(["2031-03-30T12:00:00Z", null])("retains local cutoff for %s", cycle => {
  const expected = cycle === null ? null : new Date(cycle);
  expected?.setHours(expected.getHours() - 72);
  expect(editCutoff(cycle, cycle === null ? 1 : null)).toBe(expected?.toISOString() ?? null);
});

function subscription(id: string, status: AccountSubscription["status"]): AccountSubscription {
  return {
    subscriptionId: id, shippingAddressId: null, status, pausePreset: null, pauseStartedAt: null, pauseEndsAt: null,
    cadenceDays: 28, nextCycleAt: "2031-02-01", editCutoffAt: null, canEditUpcomingPackage: false,
    editBlockedReason: "not_active", paymentMethodKind: null, paymentMethodStatus: "missing", templateVersion: 1,
    sizeConstraint: null, packageSummary: null, recurringPrice: null, lines: []
  };
}
function order(id: string): AccountOrderSummary {
  return {
    orderId: id, orderRef: `order_${id}`, orderNumber: null, subscriptionId: null, status: "paid",
    paymentStatus: "failed", fulfillmentStatus: null, total: { amountMinor: 100, currency: "EUR" },
    trackingNumber: null, trackingNumbers: [], trackingUrl: null, carrierKind: null, service: null,
    trackingReferences: [], trackingTimeline: [], deliverySelection: null,
    invoice: {
      invoiceId: `i-${id}`, orderId: id, invoiceRef: `invoice-${id}`, status: "issued",
      providerInvoiceNumber: null, ksefNumber: null, ksefStatus: "not_required", documentDeliveryStatus: "not_ready",
      totalGross: { amountMinor: 100, currency: "EUR" }, issuedAt: "2031-01-02", downloadAvailable: false,
      downloadUrl: null, createdAt: "2031-01-01"
    },
    invoiceDocuments: [], invoiceRequestStatus: "preparing", createdAt: "2031-01-01", updatedAt: "2031-01-03"
  };
}
const state: SubscriptionActionState = {
  subscriptionId: "s", orderId: "unpaid", blockedReason: "payment_expired", failureCause: "unknown",
  recoveryEligible: true, dueAt: "2031-01-01", nextRetryAt: "2031-01-04"
};
// Expected fields/order are transcribed from the donor action algorithm, never from package results.
const terminal: AccountActionRequired = {
  actionId: "subscription:s:payment_expired", kind: "payment_recovery", severity: "critical",
  entityType: "subscription", entityId: "s", subscriptionId: "s", orderId: "unpaid",
  messageCode: "payment_expired", failureCause: "unknown", blockedReason: "payment_expired",
  title: "Subscription paused after payment could not be collected",
  body: "Every retry has been used, so nothing else will be attempted. Update the payment method to resume; the unpaid cycle is skipped and a new one starts from the resume date.",
  cta: "repair_payment", recoveryEligible: true, dueAt: "2031-01-01", nextRetryAt: null
};
const activation: AccountActionRequired = {
  ...terminal, actionId: "subscription:s:activation_missing_mandate", kind: "payment_method_missing",
  messageCode: "subscription_activation_missing_mandate", blockedReason: "subscription_activation_missing_mandate",
  title: "First order paid, subscription needs a payment method",
  body: "The first order is paid. Add a card to enable future renewals without charging that order again.", recoveryEligible: false
};
it.each([
  { name: "paused terminal recovery before generic blocked guidance", status: "paused" as const, evidence: state, expected: terminal },
  { name: "pending activation before the active/paused filter", status: "pending_activation" as const,
    evidence: { ...state, blockedReason: "subscription_activation_missing_mandate" as const }, expected: activation }
])("projects populated actions: $name", async ({ status, evidence, expected }) => {
  expect(buildActionRequired([subscription("s", status)], [], new Map([["s", evidence]]), policy.canUsePaymentMethodForRenewal)).toEqual([expected]);
  const input = sources();
  input.readSubscriptionRows = async () => [{ id: "s", status, cadence_days: 28, template_version: 1 }];
  input.readActionStates = vi.fn(async () => new Map([["s", evidence]]));
  expect((await readAccountSnapshot(input, policy, { id: "owner" })).actionRequired).toEqual([expected]);
  expect(input.readActionStates).toHaveBeenCalledExactlyOnceWith(["s"]);
});
it.each([0, 4])("caps mixed donor action order with %i qualifying orders", count => {
  const subscriptions = count ? [subscription("s", "paused"), subscription("t", "pending_activation")] : [];
  const states = new Map([["s", state], ["t", { ...state, subscriptionId: "t", blockedReason: "subscription_activation_missing_mandate" as const }]]);
  const orders = Array.from({ length: count }, (_, i) => order(`o-${i}`));
  const expected: AccountActionRequired[] = count ? [terminal, { ...activation,
    actionId: "subscription:t:activation_missing_mandate", entityId: "t", subscriptionId: "t"
  }] : [];
  // Ten qualify: two subscriptions, then payment + invoice for each order. Only the first eight survive.
  if (count) for (const id of ["o-0", "o-1", "o-2"]) {
    expected.push({
      actionId: `order:${id}:payment_failed`, kind: "order_attention", severity: "critical", entityType: "order",
      entityId: id, subscriptionId: null, orderId: id, messageCode: "payment_failed", blockedReason: "payment_failed",
      failureCause: "unknown", title: "Payment failed", body: "Open the order details to review the payment status and next step.",
      cta: "view_order", recoveryEligible: false, dueAt: "2031-01-03", nextRetryAt: null
    }, {
      actionId: `invoice:i-${id}:pdf_unavailable`, kind: "invoice_attention", severity: "info", entityType: "invoice",
      entityId: `i-${id}`, subscriptionId: null, orderId: id, messageCode: "invoice_pdf_unavailable", blockedReason: "invoice_pdf_unavailable",
      failureCause: "unknown", title: "Invoice PDF unavailable", body: "The invoice is visible, but the PDF cannot be downloaded from the account yet.",
      cta: "contact_support", recoveryEligible: false, dueAt: "2031-01-02", nextRetryAt: null
    });
  }
  expect(buildActionRequired(subscriptions, orders, states, policy.canUsePaymentMethodForRenewal)).toEqual(expected);
});

// Branch sweep: each row is one donor input/state class at the extracted boundary.
it.each([
  { name: "no lines", lines: [], expected: null },
  { name: "same-currency sum", lines: [line, line], expected: { amountMinor: 246, currency: "AAA" } },
  { name: "non-string currency", lines: [{ ...line, lineSubtotal: { amountMinor: 1, currency: null } }], expected: null }
])("sweeps recurring money: $name", ({ lines, expected }) => {
  const result = recurringPrice(lines as AccountSubscriptionLine[]);
  expect(result === null ? null : result.totalGross).toEqual(expected);
  if (result) expect(result).toEqual({ subtotalGross: expected, totalGross: expected, currency: "AAA", source: "frozen_quote_line" });
});
it.each([
  { name: "missing status", row: {} }
])("sweeps hidden subscriptions: $name", ({ row }) => expect(isCustomerVisibleSubscription(row)).toBe(false));
it.each([
  { name: "missing reference fallback", kind: "card", ref: false, status: undefined, canEdit: false },
  { name: "missing kind fallback", kind: null, ref: true, status: undefined, canEdit: false },
  { name: "legacy usable fallback", kind: "card", ref: true, status: undefined, canEdit: true },
  { name: "revoked overrides legacy pointers", kind: "card", ref: true, status: "revoked" as const, canEdit: false },
  { name: "usable overrides absent pointers", kind: null, ref: false, status: "usable" as const, canEdit: true },
  { name: "usable future cutoff", kind: "card", ref: true, status: "usable" as const, cutoff: "2099-01-01", canEdit: true }
])("sweeps payment eligibility: $name", async ({ kind, ref, status, canEdit, cutoff }) => {
  const expected = { canEdit, reason: canEdit ? null : "missing_payment_method" };
  expect(computeEditState({ subscriptionId: "s", status: "active", nextCycleAt: null, editCutoffAt: cutoff ?? null,
    paymentMethodKind: kind, paymentMethodRefPresent: ref, paymentMethodStatus: status
  }, new Map(), policy.canUsePaymentMethodForRenewal)).toEqual(expected);
  // The selected policy status must reach both edit fields, even with mirrored card pointers.
  if (status) {
    const input = sources();
    input.readSubscriptionRows = async () => [{ id: "s", status: "active", payment_method_kind: kind,
      payment_method_ref: ref ? "legacy-ref" : null }];
    const paymentMethodStatus = vi.fn(() => status);
    const aggregate = await readAccountSnapshot(input, { ...policy, paymentMethodStatus }, { id: "owner" });
    expect(aggregate.subscriptions[0]).toMatchObject({ paymentMethodStatus: status,
      canEditUpcomingPackage: expected.canEdit, editBlockedReason: expected.reason });
    expect(paymentMethodStatus).toHaveBeenCalledExactlyOnceWith({ clientId: "owner", clientEmail: null,
      row: { id: "s", status: "active", payment_method_kind: kind, payment_method_ref: ref ? "legacy-ref" : null }, evidence: undefined });
  }
});
it.each([0])("sweeps explicit cutoff hours: %i", hours => {
  const cycle = "2031-01-02T12:00:00Z", expected = new Date(cycle);
  expected.setHours(expected.getHours() - hours);
  expect(editCutoff(cycle, hours)).toBe(expected.toISOString());
});
it.each(["invalid"])("sweeps invalid cutoff: %s", cycle => expect(() => editCutoff(cycle, null)).toThrow(RangeError));
it.each(["2030-01-01T00:00:00Z"])("sweeps inclusive cutoff boundary: %s", cutoff => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(cutoff));
  try {
    expect(computeEditState({ subscriptionId: "s", status: "active", nextCycleAt: null, editCutoffAt: cutoff,
      paymentMethodKind: "card", paymentMethodRefPresent: true }, new Map(), policy.canUsePaymentMethodForRenewal))
      .toEqual({ canEdit: false, reason: "edit_window_closed" });
  } finally { now.mockRestore(); }
});
it.each([false, true])("sweeps aggregate companion presence: %s", async present => {
  const input: AccountReadSources<{ captured: boolean }, string> = { ...sources(), readNextCharges: async () => new Map(present ? [["s", "charge-evidence"]] : []) }, row = { id: "s", status: "active", cadence_days: "28", template_version: "2",
    shipping_address_id: "address", next_cycle_at: "2031-01-02T12:00:00Z", edit_window_hours: 12,
    size_constraint: present ? { units: 3 } : [], payment_method_kind: "card", payment_method_ref: "ref" };
  input.readSubscriptionRows = async () => [row];
  input.readSubscriptionLines = async () => new Map(present ? [["s", [line]]] : []);
  input.readPauseWindows = async () => new Map(present ? [["s", { pausePreset: "indefinite", pauseStartedAt: "start", pauseEndsAt: "end" }]] : []);
  const alignment = { state: "aligned" } as const;
  input.readDeliveryAlignments = vi.fn(async () => new Map(present ? [["s", alignment]] : []));
  input.readPaymentEvidence = async () => new Map(present ? [["s", "evidence"]] : []);
  const packageSummary = vi.fn(() => "host-summary"), paymentMethodStatus = vi.fn(() => "usable" as const);
  const withNextCharge = vi.fn((recurringPrice: AccountSubscription["recurringPrice"], _next: string | undefined) => ({ recurringPrice }));
  const result = await readAccountSnapshot(input, { ...policy, packageSummary, paymentMethodStatus, withNextCharge }, {
    id: "owner", email: "owner@example.invalid", first_name: present ? "First" : "", last_name: null,
    phone: present ? "123" : 1, lifecycle_stage: "customer"
  });
  expect(result.profile).toEqual({ clientId: "owner", email: "owner@example.invalid", firstName: present ? "First" : null,
    lastName: null, phone: present ? "123" : null, lifecycleStage: "customer" });
  expect(result.subscriptions[0]).toMatchObject({ subscriptionId: "s", shippingAddressId: "address", cadenceDays: 28,
    templateVersion: 2, sizeConstraint: present ? { units: 3 } : null, lines: present ? [line] : [], packageSummary: "host-summary",
    pausePreset: present ? "indefinite" : null, pauseStartedAt: present ? "start" : null, pauseEndsAt: present ? "end" : null,
    editCutoffAt: "2031-01-02T00:00:00.000Z" });
  if (present) expect(result.subscriptions[0]?.deliveryAlignment).toEqual(alignment);
  else expect(result.subscriptions[0]).not.toHaveProperty("deliveryAlignment");
  expect(withNextCharge).toHaveBeenCalledExactlyOnceWith(present ? { subtotalGross: { amountMinor: 123, currency: "AAA" }, totalGross: { amountMinor: 123, currency: "AAA" }, currency: "AAA", source: "frozen_quote_line" } : null, present ? "charge-evidence" : undefined);
  expect(packageSummary).toHaveBeenCalledExactlyOnceWith(present ? [line] : [], row.size_constraint);
  expect(paymentMethodStatus).toHaveBeenCalledExactlyOnceWith({ clientId: "owner", clientEmail: "owner@example.invalid", row,
    evidence: present ? "evidence" : undefined });
  expect(input.readDeliveryAlignments).toHaveBeenCalledExactlyOnceWith(new Map([["s", row.next_cycle_at]]));
});
it.each([
  { name: "inactive ignored", status: "cancelled" as const, payment: "missing" as const, evidence: undefined, expected: [] },
  { name: "usable no action", status: "active" as const, payment: "usable" as const, evidence: undefined, expected: [] },
  { name: "legacy kind admitted", status: "active" as const, payment: undefined, kind: "card", evidence: undefined, expected: [] },
  { name: "legacy missing kind", status: "active" as const, payment: undefined, evidence: undefined, expected: ["payment_method_missing", "warning", "contact_support"] },
  { name: "unusable overrides kind", status: "active" as const, payment: "revoked" as const, kind: "card", evidence: undefined, expected: ["payment_method_missing", "warning", "contact_support"] },
  { name: "recoverable blocked", status: "active" as const, payment: "missing" as const,
    evidence: { ...state, blockedReason: "payment_blocked" as const, failureCause: "method_dead" as const }, expected: ["payment_recovery", "critical", "repair_payment"] },
  { name: "support blocked defaults", status: "active" as const, payment: "missing" as const,
    evidence: { ...state, blockedReason: null, orderId: null, dueAt: null, nextRetryAt: null, recoveryEligible: false },
    expected: ["subscription_blocked", "critical", "contact_support"] }
])("sweeps subscription actions: $name", ({ status, payment, kind, evidence, expected }) => {
  const value = { ...subscription("s", status), paymentMethodStatus: payment, paymentMethodKind: kind ?? null } as AccountSubscription;
  const result = buildActionRequired([value], [], evidence ? new Map([["s", evidence]]) : new Map(), policy.canUsePaymentMethodForRenewal);
  expect(result.map(action => [action.kind, action.severity, action.cta])).toEqual(expected.length ? [expected] : []);
  if (expected.length) expect(result[0]).toMatchObject({ subscriptionId: "s", orderId: evidence?.orderId ?? null,
    dueAt: evidence?.dueAt ?? "2031-02-01", nextRetryAt: evidence?.nextRetryAt ?? null,
    recoveryEligible: evidence?.recoveryEligible ?? false, failureCause: evidence?.failureCause ?? "unknown",
    messageCode: evidence ? evidence.blockedReason ?? "payment_blocked" : "missing_payment_method",
    blockedReason: evidence ? evidence.blockedReason : "missing_payment_method",
    body: evidence ? evidence.recoveryEligible
      ? "Your subscription is blocked until the payment method is recovered."
      : "Your subscription has a payment issue that needs support review."
      : "Add or recover a payment method before the next subscription cycle." });
});
it.each([
  { name: "requires action", status: "REQUIRES_ACTION", expected: "requires_action" },
  { name: "requires confirmation", status: "requires_confirmation", expected: "requires_action" },
  { name: "payment failed alias", status: "payment_failed", expected: "payment_failed" },
  { name: "missing method alias", status: "requires_payment_method", expected: "payment_failed" },
  { name: "no payment evidence", status: null, expected: null }
])("sweeps order actions: $name", ({ status, expected }) => {
  const result = buildActionRequired([], [{ ...order("o"), paymentStatus: status, invoice: null }], new Map(), policy.canUsePaymentMethodForRenewal);
  expect(result.map(value => value.actionId)).toEqual(expected ? [`order:o:${expected}`] : []);
  if (expected) expect(result[0]).toMatchObject({ messageCode: expected === "requires_action" ? "payment_requires_action" : "payment_failed",
    title: expected === "requires_action" ? "Payment requires action" : "Payment failed", dueAt: "2031-01-03" });
});
it.each([
  { name: "accepted missing PDF", status: "accepted", available: false, expected: true },
  { name: "issued downloadable", status: "issued", available: true, expected: false },
  { name: "draft missing PDF", status: "draft", available: false, expected: false }
])("sweeps invoice actions: $name", ({ status, available, expected }) => {
  const value = order("o");
  const result = buildActionRequired([], [{ ...value, paymentStatus: null,
    invoice: { ...value.invoice!, status, downloadAvailable: available, issuedAt: null } }], new Map(), policy.canUsePaymentMethodForRenewal);
  expect(result.map(action => action.actionId)).toEqual(expected ? ["invoice:i-o:pdf_unavailable"] : []);
  if (expected) expect(result[0]?.dueAt).toBe("2031-01-01");
});
it.each([{}])("sweeps absent profile fields", async client => {
  expect((await readAccountSnapshot(sources(), policy, client)).profile).toEqual({ clientId: "", email: "", firstName: null,
    lastName: null, phone: null, lifecycleStage: "" });
});
it.each(["invalid hours"])("sweeps aggregate cutoff default: %s", async editWindow => {
  const input = sources();
  input.readSubscriptionRows = async () => [{ id: "s", status: "active", next_cycle_at: "2031-01-02T12:00:00Z", edit_window_hours: editWindow }];
  const date = new Date("2031-01-02T12:00:00Z"); date.setHours(date.getHours() - 72);
  expect((await readAccountSnapshot(input, policy, { id: "owner" })).subscriptions[0]?.editCutoffAt).toBe(date.toISOString());
});
it.each([
  { name: "blocker before unusable payment", blocker: true, cutoff: null, expected: "cycle_locked" },
  { name: "missing payment before closed window", blocker: false, cutoff: "2000-01-01", expected: "missing_payment_method" }
])("sweeps eligibility conflicts: $name", ({ blocker, cutoff, expected }) => {
  expect(computeEditState({ subscriptionId: "s", status: "active", nextCycleAt: null, editCutoffAt: cutoff,
    paymentMethodKind: "card", paymentMethodRefPresent: true, paymentMethodStatus: "revoked"
  }, blocker ? new Map([["s", "cycle_locked"]]) : new Map(), policy.canUsePaymentMethodForRenewal))
    .toEqual({ canEdit: false, reason: expected });
});
it.each([
  { name: "terminal null deadline", status: "paused" as const, blockedReason: "payment_expired" as const, expected: { ...terminal, dueAt: null, failureCause: "method_dead" as const } },
  { name: "activation null deadline", status: "pending_activation" as const, blockedReason: "subscription_activation_missing_mandate" as const, expected: { ...activation, dueAt: null } }
])("sweeps special action metadata: $name", ({ status, blockedReason, expected }) => {
  expect(buildActionRequired([subscription("s", status)], [], new Map([["s", { ...state, blockedReason, dueAt: null, failureCause: "method_dead" }]]), policy.canUsePaymentMethodForRenewal))
    .toEqual([expected]);
});
it.each(["omitted state map"])("sweeps action evidence default: %s", () => {
  expect(buildActionRequired([{ ...subscription("s", "active"), paymentMethodStatus: undefined, paymentMethodKind: "card" }], [], undefined, policy.canUsePaymentMethodForRenewal)).toEqual([]);
});
