import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { Pet, Subscription } from "../lib/subscriptionEditModel";
import { SubscriptionScreen, type SubscriptionActions } from "./SubscriptionScreen";

const NOW = "2026-06-23T09:00:00.000Z";
const CURRENCY = "PLN";

const subscription = {
  subscriptionId: "s1",
  petId: "p1",
  shippingAddressId: "a1",
  status: "active",
  pausePreset: null,
  pauseStartedAt: null,
  pauseEndsAt: null,
  cadenceDays: 14,
  nextCycleAt: "2026-06-29T10:00:00.000Z",
  editCutoffAt: "2026-06-27T10:00:00.000Z",
  canEditUpcomingPackage: true,
  editBlockedReason: null,
  paymentMethodKind: "blik",
  templateVersion: 3,
  sizeConstraint: null,
  packageSummary: null,
  recurringPrice: {
    subtotalGross: { amountMinor: 18760, currency: CURRENCY },
    totalGross: { amountMinor: 18760, currency: CURRENCY },
    currency: CURRENCY,
    source: "frozen_quote_line",
  },
  lines: [
    { lineId: "l1", variantId: "v-lamb", qty: 7, sortOrder: 0, isAddon: false, title: "Jagnięcina", sku: null, recipeName: "Jagnięcina", unitPrice: { amountMinor: 1000, currency: CURRENCY }, lineSubtotal: { amountMinor: 7000, currency: CURRENCY } },
    { lineId: "l2", variantId: "v-turkey", qty: 5, sortOrder: 1, isAddon: false, title: "Indyk", sku: null, recipeName: "Indyk", unitPrice: { amountMinor: 1000, currency: CURRENCY }, lineSubtotal: { amountMinor: 5000, currency: CURRENCY } },
    { lineId: "l3", variantId: "v-salmon", qty: 2, sortOrder: 2, isAddon: false, title: "Łosoś", sku: null, recipeName: "Łosoś", unitPrice: { amountMinor: 2880, currency: CURRENCY }, lineSubtotal: { amountMinor: 5760, currency: CURRENCY } },
    { lineId: "l4", variantId: "v-top", qty: 1, sortOrder: 3, isAddon: true, title: "Topper", sku: null, recipeName: null, unitPrice: null, lineSubtotal: null },
  ],
} as unknown as Subscription;

const pet = {
  petId: "p1",
  petType: "dog",
  name: "Burek",
  breed: "Labrador",
  ageLabel: null,
  weightKg: 28,
  activityLevel: null,
  bodyCondition: null,
  allergies: [],
  photoUrl: null,
  removedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
} as unknown as Pet;

const account = {
  addresses: [
    { addressId: "a1", kind: "both", label: "Dom", recipientName: null, contactPhone: null, companyName: null, taxId: null, line1: "ul. Lipowa 14/3", line2: null, city: "Kraków", postalCode: "30-001", country: "PL", isDefault: true, deliveryNotes: null, courierInstructions: null, lastUsedAt: NOW, createdAt: NOW, updatedAt: NOW },
  ],
} as unknown as CustomerAccountV2Response;

const actions: SubscriptionActions = {
  onEdit: vi.fn(),
  onReschedule: vi.fn(),
  onSkip: vi.fn(),
  onPause: vi.fn(),
  onResume: vi.fn(),
  onCancel: vi.fn(),
  onManageAddons: vi.fn(),
  onReactivate: vi.fn(),
  onOrderNow: vi.fn(),
  onChangeAddress: vi.fn(),
  onCompletePayment: vi.fn(),
  onRepair: vi.fn(),
};

// The state the account page used to hide: paused by the renewal engine while a
// recovery case is open. `editBlockedReason` reads `not_active` here, which is
// exactly why the screen has to read the case instead.
const pausedInRecovery = {
  ...subscription,
  status: "paused",
  canEditUpcomingPackage: false,
  editBlockedReason: "not_active",
} as unknown as Subscription;

const dunningAccount = {
  ...account,
  recentOrders: [{ orderId: "o1", total: { amountMinor: 13702, currency: CURRENCY } }],
  actionRequired: [
    {
      actionId: "subscription:s1:payment_blocked",
      kind: "payment_recovery",
      severity: "critical",
      entityType: "subscription",
      entityId: "s1",
      subscriptionId: "s1",
      orderId: "o1",
      messageCode: "payment_blocked",
      failureCause: "unknown" as const,
      blockedReason: "payment_blocked",
      title: "Payment needs attention",
      body: null,
      cta: "repair_payment",
      recoveryEligible: true,
      dueAt: "2026-07-02T10:00:00.000Z",
      nextRetryAt: "2026-07-01T10:00:00.000Z",
    },
  ],
} as unknown as CustomerAccountV2Response;

const LANG = "pl" as const;

function renderScreen(
  row: Subscription,
  options: { account?: CustomerAccountV2Response; actions?: SubscriptionActions } = {},
) {
  return render(
    <SubscriptionScreen
      account={options.account ?? account}
      subscription={row}
      pet={pet}
      lang={LANG}
      actions={options.actions ?? actions}
    />,
  );
}

describe("SubscriptionScreen", () => {
  it("renders the package with recipe chips, status and plan facts", () => {
    renderScreen(subscription);
    expect(screen.getByRole("heading", { level: 1, name: /Subskrypcja Burek/i })).toBeInTheDocument();
    expect(screen.getAllByText("Jagnięcina").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/14 puszek/).length).toBeGreaterThan(0);
    expect(screen.getByText(/ul\. Lipowa 14\/3/)).toBeInTheDocument();
  });

  it("presents the header as an estimated delivery window plus a charge/edit line", () => {
    renderScreen(subscription);
    // nextCycleAt = Mon 29.06 12:00 Warsaw -> same-day dispatch -> Tue 30.06 / Wed 1.07.
    // Two occurrences by design: the header eyebrow and the plan-facts row label.
    expect(screen.getAllByText("Szacowana dostawa").length).toBe(2);
    expect(screen.getByText(/30\.06–1\.07 · za \d+ dni/)).toBeInTheDocument();
    expect(screen.getByText("Planowana opłata 29.06 · zmiany w składzie do 27.06")).toBeInTheDocument();
    expect(screen.queryByText("Następna dostawa")).toBeNull();
  });

  it("moves the header window by the cut-off for a Friday-evening charge", () => {
    const fridayEvening = {
      ...subscription,
      // Fri 3 Apr 2026, 19:00 Warsaw — after the 16:00 cut-off.
      nextCycleAt: "2026-04-03T17:00:00.000Z",
      editCutoffAt: "2026-03-31T10:00:00.000Z",
    } as unknown as Subscription;
    renderScreen(fridayEvening);
    // Easter Monday (6 Apr 2026) defers dispatch; window is now Wed-Thu and the
    // header line carries the conditional holiday note. Re-baselined with this wave.
    expect(screen.getByText(/8–9\.04 · za \d+ dni/)).toBeInTheDocument();
    expect(screen.getByText("Planowana opłata 3.04 · zmiany w składzie do 31.03 · uwzględnia dni wolne")).toBeInTheDocument();
  });

  it("shows the frozen recurring price and uses the edit-window note", () => {
    renderScreen(subscription);
    expect(screen.getByText(/187,60/)).toBeInTheDocument();
    expect(screen.queryByText(/-15%|−15%/)).toBeNull();
    expect(screen.getByText(/Zmiany w składzie możliwe do/)).toBeInTheDocument();
  });

  it("keeps blocked order-now visible with a reason", () => {
    const blocked = {
      ...subscription,
      canEditUpcomingPackage: false,
      editBlockedReason: "payment_blocked",
    } as unknown as Subscription;
    renderScreen(blocked);
    expect(screen.getByRole("button", { name: "Zamów teraz" })).toBeDisabled();
    expect(screen.getAllByText(/Najpierw napraw płatność/).length).toBeGreaterThan(0);
  });

  it("keeps an in-transit paid parcel ahead of estimated deliveries in the schedule", () => {
    const inTransitAccount = {
      ...account,
      recentOrders: [{
        orderId: "o1",
        subscriptionId: "s1",
        status: "paid",
        fulfillmentStatus: "in_transit",
        createdAt: NOW,
        trackingTimeline: [],
      }],
    } as unknown as CustomerAccountV2Response;
    renderScreen(subscription, { account: inTransitAccount });

    expect(screen.getAllByText("W drodze").length).toBeGreaterThan(0);
    const inFlightItem = screen.getByText("W realizacji").closest("li");
    const firstEstimate = inFlightItem?.nextElementSibling;
    expect(firstEstimate).not.toBeNull();
    expect(within(firstEstimate as HTMLElement).getByText("30.06")).toBeInTheDocument();
    expect(within(firstEstimate as HTMLElement).queryByText("29.06")).not.toBeInTheDocument();
    // Renewal remains available as an explicit fact outside the delivery axis.
    expect(screen.getAllByText("Następne odnowienie").length).toBeGreaterThan(0);
  });

  it("explains protected delivery alignment and reuses the reschedule action", () => {
    const onReschedule = vi.fn();
    const protectedSubscription = {
      ...subscription,
      deliveryAlignment: { state: "protected" },
    } as unknown as Subscription;
    renderScreen(protectedSubscription, { actions: { ...actions, onReschedule } });

    expect(screen.getByRole("status")).toHaveTextContent("Opóźniona przesyłka: kolejne odnowienie wstrzymane");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Nie pobierzemy kolejnej opłaty, dopóki bieżąca paczka nie zostanie dostarczona.",
    );
    expect(screen.getAllByRole("button", { name: "Zmień termin" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Zmień termin" }));
    expect(onReschedule).toHaveBeenCalledTimes(1);
  });

  it("explains an already-aligned renewal without asking the customer to decide", () => {
    const alignedSubscription = {
      ...subscription,
      deliveryAlignment: { state: "aligned" },
    } as unknown as Subscription;
    renderScreen(alignedSubscription);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Paczka dotarła. Dopasowaliśmy termin",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Kolejne odnowienie przesunęliśmy na 29 czerwca, aby zachować rytm dostaw.",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not offer a delivery-alignment reschedule that the server would reject", () => {
    const blockedSubscription = {
      ...subscription,
      canEditUpcomingPackage: false,
      editBlockedReason: "payment_blocked",
      deliveryAlignment: { state: "protected" },
    } as unknown as Subscription;
    renderScreen(blockedSubscription);

    expect(screen.getByRole("status")).toHaveTextContent("Opóźniona przesyłka: kolejne odnowienie wstrzymane");
    expect(screen.getByRole("button", { name: "Zmień termin" })).toBeDisabled();
  });

  it("renders a pending_activation subscription honestly, not as 'Aktywna'", () => {
    const pending = {
      ...subscription,
      status: "pending_activation",
      nextCycleAt: null,
      editCutoffAt: null,
      canEditUpcomingPackage: false,
      editBlockedReason: "not_active",
    } as unknown as Subscription;
    renderScreen(pending);
    // Honest badge — never the active label.
    expect(screen.getByText("Oczekuje na płatność")).toBeInTheDocument();
    expect(screen.queryByText("Aktywna")).toBeNull();
    // Explanatory panel instead of a fake editable plan.
    expect(screen.getByText(/Subskrypcja czeka na dokończenie płatności/)).toBeInTheDocument();
    // Edit disabled; the misleading "edit window closed" note is gone.
    expect(screen.getByRole("button", { name: /Edytuj pakiet/ })).toBeDisabled();
    expect(screen.queryByText(/Okno edycji najbliższej dostawy jest zamknięte/)).toBeNull();
    expect(
      screen.getByText(/Edycja pakietu będzie dostępna po aktywacji subskrypcji/),
    ).toBeInTheDocument();
    // No reschedule control surfaces for a never-activated subscription.
    expect(screen.queryByText("Zmień termin")).toBeNull();
  });

  it("offers a 'Dokończ płatność' CTA on a pending_activation subscription (W5)", () => {
    const onCompletePayment = vi.fn();
    const pending = {
      ...subscription,
      status: "pending_activation",
      nextCycleAt: null,
      editCutoffAt: null,
      canEditUpcomingPackage: false,
      editBlockedReason: "not_active",
    } as unknown as Subscription;
    renderScreen(pending, { actions: { ...actions, onCompletePayment } });
    const cta = screen.getByRole("button", { name: "Dokończ płatność" });
    fireEvent.click(cta);
    expect(onCompletePayment).toHaveBeenCalledTimes(1);
  });

  it("does NOT offer the recovery CTA on an activation_failed subscription (W5)", () => {
    const failed = {
      ...subscription,
      status: "activation_failed",
      nextCycleAt: null,
      editCutoffAt: null,
      canEditUpcomingPackage: false,
      editBlockedReason: "not_active",
    } as unknown as Subscription;
    renderScreen(failed);
    expect(screen.queryByRole("button", { name: "Dokończ płatność" })).toBeNull();
  });

  it("renders a paused-by-recovery subscription as blocked, with the amount and a working CTA", () => {
    const onRepair = vi.fn();
    renderScreen(pausedInRecovery, { account: dunningAccount, actions: { ...actions, onRepair } });
    // The badge must not read the neutral "Wstrzymana" the customer never chose.
    expect(screen.getByText("Płatność")).toBeInTheDocument();
    expect(screen.queryByText("Wstrzymana")).toBeNull();
    // Amount from the case's order, and the scheduled attempt.
    expect(screen.getByText(/137,02/)).toBeInTheDocument();
    expect(screen.getByText(/Kolejna próba obciążenia: 1 lipca/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Napraw płatność" }));
    expect(onRepair).toHaveBeenCalledTimes(1);
  });

  it("offers exactly the actions the server still accepts while recovery is open", () => {
    renderScreen(pausedInRecovery, { account: dunningAccount });
    // Refused by customer_self_service_apply_subscription_action.
    expect(screen.getByRole("button", { name: "Wznów dostawy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Edytuj pakiet/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Zmień termin" })).toBeDisabled();
    // Still accepted: cancel closes the case, change-address is excluded from the guard.
    expect(screen.getByRole("button", { name: "Anuluj subskrypcję" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Zmień adres dostawy" })).toBeEnabled();
    expect(screen.getAllByText(/Najpierw napraw płatność/).length).toBeGreaterThan(0);
  });

  it("leaves a paused subscription WITHOUT a recovery case exactly as it was", () => {
    const paused = { ...subscription, status: "paused" } as unknown as Subscription;
    renderScreen(paused);
    expect(screen.getByText("Wstrzymana")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wznów dostawy" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Napraw płatność" })).toBeNull();
  });

  it("renders the stored method's status when the payload carries one", () => {
    const expiring = {
      ...subscription,
      paymentMethodStatus: "expiring",
    } as unknown as Subscription;
    renderScreen(expiring);
    expect(screen.getByText("Stan metody")).toBeInTheDocument();
    expect(screen.getByText("Wkrótce wygasa")).toBeInTheDocument();
  });

  it("renders an activation_failed subscription with a failed state", () => {
    const failed = {
      ...subscription,
      status: "activation_failed",
      nextCycleAt: null,
      editCutoffAt: null,
      canEditUpcomingPackage: false,
      editBlockedReason: "not_active",
    } as unknown as Subscription;
    renderScreen(failed);
    expect(screen.getByText("Aktywacja nieudana")).toBeInTheDocument();
    expect(screen.getByText(/Aktywacja subskrypcji nie powiodła się/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edytuj pakiet/ })).toBeDisabled();
  });
});
