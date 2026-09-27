import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { PaymentsSection } from "./PaymentsSection";

const mockUpsertCustomerPaymentPreference = vi.hoisted(() => vi.fn());

vi.mock("@/domains/customers/customerPreferencesClient", () => ({
  upsertCustomerPaymentPreference: mockUpsertCustomerPaymentPreference,
}));

const account = {
  paymentPreferences: [{
    scope: "subscription",
    methodKind: "card",
    lastSelectedAt: "2026-06-20T10:00:00+00:00",
  }],
  actionRequired: [],
} as unknown as CustomerAccountV2Response;

describe("PaymentsSection", () => {
  it("saves the payment preference through the account payment diagnostic category", async () => {
    mockUpsertCustomerPaymentPreference.mockResolvedValue({});
    const mutate = vi.fn(async (work: () => Promise<unknown>) => {
      await work();
      return true;
    });

    render(
      <PaymentsSection
        account={account}
        lang="en"
        accessToken="tok"
        mutate={mutate}
        targetSubscriptionId={null}
        captureFlows={[{ kind: "card_on_file_setup", handoff: "embedded_client_secret" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edytuj" }));
    fireEvent.click(screen.getByRole("button", { name: "Zapisz" }));

    await waitFor(() => {
      expect(mockUpsertCustomerPaymentPreference).toHaveBeenCalledWith("tok", {
        scope: "subscription",
        methodKind: "card",
      });
      expect(mutate).toHaveBeenCalledWith(expect.any(Function), "account_payment_mutation");
    });
    expect(screen.queryByText("Anuluj")).not.toBeInTheDocument();
  });
});
