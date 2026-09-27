import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/pages/admin/DashboardPage";
import { renderWithProviders } from "@/test/render";
import { listResponse } from "./OrdersPage.testHelpers";

const { mockGetAdminCommerceOrders } = vi.hoisted(() => ({
  mockGetAdminCommerceOrders: vi.fn(),
}));

vi.mock("@/domains/commerce/omsClient", () => ({
  getAdminCommerceOrders: mockGetAdminCommerceOrders,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    session: { access_token: "admin-token" },
  }),
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    mockGetAdminCommerceOrders.mockReset();
    const kpiResponse = listResponse({
      totalCount: 42,
      summaryTotals: {
        gmv: { amountMinor: 12300, currency: "PLN" },
        aov: { amountMinor: 2900, currency: "PLN" },
        orderCount: 42,
        paidSubscriptionCycleCount: 4,
      },
    });
    const queueResponse = listResponse({ totalCount: 42 });
    queueResponse.summaryCounts = {
      needsAttention: 11,
      activeHold: 3,
      readyForFulfillment: 5,
      paymentIssues: 7,
      inventoryRisk: 13,
      fulfillmentBlocked: 17,
      fulfillmentExceptions: 19,
      invoiceIssues: 23,
      omnipackDispatchedNotPicked: 0,
    };
    const recentResponse = listResponse({
      totalCount: 3,
      orders: [{ ...listResponse().orders[0], orderNumber: "OMS-2002", nextAction: "none", status: "paid" }],
    });
    mockGetAdminCommerceOrders.mockImplementation((_token, request) => {
      if (request.attentionOnly === true) return Promise.resolve(queueResponse);
      if (request.sort === "created_desc") return Promise.resolve(recentResponse);
      return Promise.resolve(kpiResponse);
    });
  });

  it("renders OMS KPI data from summaryTotals without client-side aggregation", async () => {
    renderWithProviders(<DashboardPage />);

    expect(await screen.findByRole("heading", { name: "Cześć, Operator" })).toBeInTheDocument();
    expect(screen.getByText("KPI")).toBeInTheDocument();
    expect(screen.getByText("24 godz.")).toBeInTheDocument();
    await waitFor(() => {
      expectMetricValue("Przychód (GMV)", /123,00\s?zł/);
      expectMetricValue("Zamówienia", "42");
      expectMetricValue("Śr. wartość (AOV)", /29,00\s?zł/);
      expectMetricValue("Opłacone cykle subskrypcji", "4");
    });
    expect(mockGetAdminCommerceOrders).toHaveBeenCalledWith(
      "admin-token",
      expect.objectContaining({ page: 1, pageSize: 1, sort: "updated_desc" }),
    );
    expect(mockGetAdminCommerceOrders).toHaveBeenCalledWith(
      "admin-token",
      expect.objectContaining({ page: 1, pageSize: 6, sort: "attention_priority_desc", attentionOnly: true }),
    );
    expect(mockGetAdminCommerceOrders).toHaveBeenCalledWith(
      "admin-token",
      expect.objectContaining({ page: 1, pageSize: 6, sort: "created_desc", attentionOnly: false }),
    );
  });

  it("defaults the KPI window to 30 days and offers an all-time range", async () => {
    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });
    expect(screen.getByRole("button", { name: "30 dni" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cały okres" }));

    await waitFor(() => {
      const allTimeCall = mockGetAdminCommerceOrders.mock.calls.find(
        ([, request]) => request.sort === "updated_desc" && request.from === undefined && request.to === undefined,
      );
      expect(allTimeCall, "KPI query should omit from/to for the all-time range").toBeTruthy();
    });
  });

  it("renders a genuine recent-orders feed independent of the attention queue", async () => {
    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });
    expect(await screen.findByText("Ostatnie zamówienia")).toBeInTheDocument();
    expect(await screen.findByText(/OMS-2002/)).toBeInTheDocument();
  });

  it("shows an empty-window hint when the KPI window has zero paid orders", async () => {
    mockGetAdminCommerceOrders.mockImplementation((_token, request) => {
      if (request.attentionOnly === true) return Promise.resolve(listResponse({ totalCount: 0 }));
      if (request.sort === "created_desc") return Promise.resolve(listResponse({ totalCount: 0, orders: [] }));
      return Promise.resolve(
        listResponse({
          totalCount: 0,
          summaryTotals: {
            gmv: { amountMinor: 0, currency: "PLN" },
            aov: { amountMinor: 0, currency: "PLN" },
            orderCount: 0,
            paidSubscriptionCycleCount: 0,
          },
        }),
      );
    });

    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });
    expect(
      await screen.findByText("Brak opłaconych zamówień w wybranym oknie. Poszerz zakres."),
    ).toBeInTheDocument();
  });

  it("renders operational tile counts from matching summaryCounts fields", async () => {
    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });

    await waitFor(() => {
      expectMetricValue("Wymaga decyzji", "11");
      expectMetricValue("Gotowe do zlecenia wysyłki", "5");
      expectMetricValue("Wyjątki wysyłki", "19");
      expectMetricValue("Problemy z płatnością", "7");
      expectMetricValue("Brak rezerwacji", "13");
      expectMetricValue("Problemy z fakturami", "23");
    });
    expect(screen.queryByText("Wyjątki fulfillmentu")).not.toBeInTheDocument();
  });

  it("switches dashboard mode and period through segmented controls", async () => {
    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });
    fireEvent.click(screen.getByRole("button", { name: "Kolejka" }));
    fireEvent.click(screen.getByRole("button", { name: "7 dni" }));

    expect(screen.getAllByText("Wymaga decyzji").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(mockGetAdminCommerceOrders).toHaveBeenCalledWith(
        "admin-token",
        expect.objectContaining({ page: 1, pageSize: 1, sort: "updated_desc" }),
      );
    });
  });

  it("does not render raw Polish fulfillment jargon on the dashboard", async () => {
    renderWithProviders(<DashboardPage />);

    await screen.findByRole("heading", { name: "Cześć, Operator" });

    expect(screen.queryByText(/fulfillment/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Brak akcji")).not.toBeInTheDocument();
  });
});

function expectMetricValue(label: string, expected: string | RegExp) {
  const matchingCard = screen
    .getAllByText(label)
    .map((labelNode) => labelNode.parentElement?.parentElement)
    .find((card): card is HTMLElement => {
      if (!card) return false;
      const text = card.textContent ?? "";
      return typeof expected === "string" ? text.includes(expected) : expected.test(text);
    });

  expect(matchingCard, `metric card "${label}" should render value ${String(expected)}`).toBeTruthy();
}
