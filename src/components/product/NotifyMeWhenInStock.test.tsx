import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotifyMeWhenInStock } from "@/components/product/NotifyMeWhenInStock";
import { renderWithProviders } from "@/test/render";

const notifyMock = vi.fn();
vi.mock("@/domains/commerce/commerceClient", () => ({
  notifyWhenInStock: (...args: unknown[]) => notifyMock(...args),
}));

describe("NotifyMeWhenInStock", () => {
  beforeEach(() => {
    notifyMock.mockReset();
  });

  it("renders PL copy and keeps submit disabled until a valid email + consent", () => {
    renderWithProviders(<NotifyMeWhenInStock sku="OPENLUP-LAMB-5KG" />);
    screen.getByText("Powiadom mnie, gdy wróci");
    const button = screen.getByRole("button", { name: "Powiadom mnie" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // Valid email but no consent → still disabled.
    fireEvent.change(screen.getByLabelText("Twój e-mail"), { target: { value: "buyer@example.com" } });
    expect(button.disabled).toBe(true);
  });

  it("posts to the BFF and shows the confirmation when email + consent are provided", async () => {
    notifyMock.mockResolvedValue(undefined);
    renderWithProviders(<NotifyMeWhenInStock sku="OPENLUP-LAMB-5KG" />);
    fireEvent.change(screen.getByLabelText("Twój e-mail"), { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByRole("checkbox"));
    const button = screen.getByRole("button", { name: "Powiadom mnie" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() =>
      expect(notifyMock).toHaveBeenCalledWith({
        sku: "OPENLUP-LAMB-5KG",
        email: "buyer@example.com",
        marketingConsent: true,
        locale: "pl",
      }),
    );
    await screen.findByText(/Damy znać/);
  });

  it("shows an inline error when the BFF call fails", async () => {
    notifyMock.mockRejectedValue(new Error("boom"));
    renderWithProviders(<NotifyMeWhenInStock sku="X" />);
    fireEvent.change(screen.getByLabelText("Twój e-mail"), { target: { value: "buyer@example.com" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Powiadom mnie" }));
    await screen.findByText("Nie udało się zapisać. Spróbuj ponownie.");
  });

  it("renders EN copy for locale=en", () => {
    renderWithProviders(<NotifyMeWhenInStock sku="X" locale="en" />);
    screen.getByText("Notify me when it's back");
  });
});
