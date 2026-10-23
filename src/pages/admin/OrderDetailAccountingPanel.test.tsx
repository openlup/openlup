import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { OrderDetailAccountingPanel } from "./OrderDetailAccountingPanel";
import { getAdminAccountingOrderSummary } from "@/domains/accounting/accountingClient";

vi.mock("@/domains/accounting/accountingClient", () => ({ getAdminAccountingOrderSummary: vi.fn() }));
vi.mock("./OrderDetailAccountingSection", () => ({ OrderDetailAccountingSection: ({ summary }: { summary: unknown }) => <pre data-testid="summary">{JSON.stringify(summary)}</pre> }));

it("reads only with a session and projects closed diagnostics without provider errors or URL detail", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const read = vi.mocked(getAdminAccountingOrderSummary);
  read.mockResolvedValue({ summary: { orderId: "order-a", status: "outbox_failed", invoice: null, documents: [], recoveryGuidance: "review_and_retry", outbox: { status: "failed", attemptCount: 1, nextAttemptAt: null, lastError: { code: "secret-provider-code", message: "https://example.invalid/private?token=secret", retryable: false } } } });
  const view = render(<QueryClientProvider client={client}><OrderDetailAccountingPanel orderId="order-a" accessToken={undefined} locale="en" t={((key: string) => key) as TFunction} /></QueryClientProvider>);
  expect(read).not.toHaveBeenCalled();
  view.rerender(<QueryClientProvider client={client}><OrderDetailAccountingPanel orderId="order-a" accessToken="synthetic-session" locale="en" t={((key: string) => key) as TFunction} /></QueryClientProvider>);
  await waitFor(() => expect(screen.getByTestId("summary").textContent).toContain('"code":"unknown"'));
  expect(read).toHaveBeenCalledWith("synthetic-session", "order-a");
  expect(screen.getByTestId("summary").textContent).not.toMatch(/secret|https:/);
});
