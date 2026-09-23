// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { RescheduleModal } from "@/pages/account/v2/subscriptions/modals/RescheduleModal";
import { createReferenceI18n } from "./subscriptionMessages";

describe("selected profile renewal language", () => {
  it("renders the existing modal as planned renewal/charge with a separate estimated delivery", () => {
    const onAction = vi.fn();
    const nextCycleAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
    render(
      <I18nextProvider i18n={createReferenceI18n()}>
        <RescheduleModal
          subscription={{ subscriptionId: "s1", nextCycleAt, editCutoffAt: null, cadenceDays: 28 }}
          lang="en"
          open
          onOpenChange={() => undefined}
          onAction={onAction}
        />
      </I18nextProvider>,
    );
    expect(screen.getByRole("dialog", { name: "Change the next renewal date" })).toBeInTheDocument();
    expect(screen.getByText(/Delivery timing is an estimate, not a promise/)).toBeInTheDocument();
    const different = screen.getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "false");
    expect(different).toBeDefined();
    fireEvent.click(different!);
    expect(screen.getByText(/Planned renewal and charge:/)).toBeInTheDocument();
    expect(screen.getByText(/Estimated delivery window, not guaranteed:/)).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });
});
