// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AccountSupportAccount, type AccountSupportAccountStrings } from "./accountSupportAccount";
import { AccountSupportCustomer360, type AccountSupportCustomer360Strings } from "./accountSupportCustomer360";
import type { AccountSnapshot } from "@openlup/platform/account-support/contracts";

it(
  "renders last-known, unknown and partial reads; refresh/inline expansion performs no detail or command call",
  () => {
    const accountStrings: AccountSupportAccountStrings = {
      title: "Account",
      loading: "Loading",
      error: "Read failed",
      unavailable: "Unavailable",
      unknown: "Unknown",
      refresh: "Refresh account",
      subscriptions: "Subscriptions",
      nextCycle: "Next cycle",
      nextCharge: "Next charge",
      addresses: "Addresses",
      billing: "Billing",
      preferences: "Preferences",
      orders: "Orders",
      expand: "Expand summary",
      documents: "Documents",
      download: "Download",
      tracking: "Tracking",
      profile: "Profile"
    };
    const supportStrings: AccountSupportCustomer360Strings = {
      title: "Support",
      query: "Lookup",
      search: "Search",
      refresh: "Refresh support",
      loading: "Loading",
      denied: "Denied",
      unavailable: "Unavailable",
      noMatches: "No matches",
      unknown: "Unknown",
      partial: "Partial evidence",
      orders: "Orders",
      subscriptions: "Subscriptions",
      payment: "Payment",
      recovery: "Recovery",
      audit: "Audit",
      contact: "Contact",
      addresses: "Addresses"
    };
    const refresh = vi.fn(),
      search = vi.fn(),
      select = vi.fn(),
      detail = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected_detail_io"));
    const data: AccountSnapshot = {
      contractVersion: "customer.account.v3",
      profile: {
        clientId: "a",
        email: "a@example.invalid",
        firstName: null,
        lastName: null,
        phone: null,
        lifecycleStage: "customer"
      },
      extension: null,
      subscriptions: [],
      addresses: [],
      ordererProfiles: [],
      billingProfiles: [],
      paymentPreferences: [],
      deliveryPreferences: [],
      events: [],
      actionRequired: [],
      recentOrders: [{
        orderId: "o",
        orderRef: "order_o",
        orderNumber: "REF-o",
        subscriptionId: null,
        status: "paid",
        paymentStatus: null,
        fulfillmentStatus: null,
        total: { amountMinor: 17, currency: "EUR" },
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
        invoiceRequestStatus: "not_requested",
        createdAt: "",
        updatedAt: ""
      }]
    };
    const view = render(<>
      <AccountSupportAccount
        data={data}
        loading
        error="temporarily unavailable"
        strings={accountStrings}
        onRefresh={refresh}
      />
      <AccountSupportCustomer360
        data={null}
        results={{ contractVersion: "support.customer_360.v2", query: "", candidates: [], warnings: [] }}
        state="denied"
        strings={supportStrings}
        onSearch={search}
        onSelect={select}
        onRefresh={refresh}
      />
    </>);
    expect(screen.getByText("a@example.invalid")).toBeTruthy();
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(screen.getByText("Denied")).toBeTruthy();
    fireEvent.click(screen.getByText("Expand summary"));
    expect(detail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Refresh account"));
    expect(refresh).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText("Lookup"), { target: { value: "ambiguous" } });
    fireEvent.click(screen.getByText("Search"));
    expect(search).toHaveBeenCalledExactlyOnceWith("ambiguous", 10);
    expect(select).not.toHaveBeenCalled();
    expect(view.container.querySelector("details")?.open).toBe(true);
    expect(view.container.textContent).toContain("Unknown");
    expect(view.container.textContent).not.toContain("Pause");
    view.rerender(<AccountSupportCustomer360
      data={{
        contractVersion: "support.customer_360.v2",
        subject: {
          subjectId: "s",
          displayName: null,
          email: null,
          lifecycleStage: "customer",
          lifecycle: [],
          firstSeenAt: null,
          lastActivityAt: null
        },
        lookup: {
          query: "s",
          matchedBy: "subject_id",
          confidence: "exact",
          warnings: ["evidence_partial:customer_profile"]
        },
        orders: [],
        subscriptions: [],
        payment: [],
        dunningCases: [],
        recovery: [],
        auditTrail: []
      }}
      results={null}
      state="loading"
      strings={supportStrings}
      onSearch={search}
      onSelect={select}
      onRefresh={refresh}
    />);
    expect(screen.getByText(/Partial evidence/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Loading");
    expect(view.container.textContent).toContain("Unknown");
    view.unmount();
    detail.mockRestore();
  }
);
