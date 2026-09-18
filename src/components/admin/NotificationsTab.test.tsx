import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NotificationsTab from "@/components/admin/NotificationsTab";
import { renderWithProviders } from "@/test/render";

const {
  toastSuccess,
  toastError,
  getRecipientsMock,
  createRecipientMock,
  updateRecipientMock,
  deleteRecipientMock,
} = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  getRecipientsMock: vi.fn(),
  createRecipientMock: vi.fn(),
  updateRecipientMock: vi.fn(),
  deleteRecipientMock: vi.fn(),
}));

const recipients = [
  {
    id: "rec-1",
    email: "warehouse@example.com",
    name: "Warehouse",
    active: true,
    notification_type: "packaging_digest",
    created_at: "2026-05-01T10:00:00.000Z",
  },
];

vi.mock("@/domains/communications/adminNotificationRecipientsClient", () => ({
  getAdminNotificationRecipients: getRecipientsMock,
  createAdminNotificationRecipient: createRecipientMock,
  updateAdminNotificationRecipient: updateRecipientMock,
  deleteAdminNotificationRecipient: deleteRecipientMock,
}));

vi.mock("@/lib/authContext", () => ({
  useAuth: () => ({
    session: {
      access_token: "admin-token",
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
    message: vi.fn(),
  },
}));

describe("NotificationsTab", () => {
  beforeEach(() => {
    getRecipientsMock.mockResolvedValue({ recipients });
    createRecipientMock.mockResolvedValue({
      created: true,
      email: "new@example.com",
      notification_type: "packaging_digest",
    });
    updateRecipientMock.mockResolvedValue({ updated: true, recipientId: "rec-1" });
    deleteRecipientMock.mockResolvedValue({ deleted: true, recipientId: "rec-1" });
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("preserves recipient CRUD and non-tester cards without a packaging send action", async () => {
    renderWithProviders(<NotificationsTab />);

    expect(await screen.findByText(/Warehouse/)).toBeInTheDocument();
    expect(screen.queryByTitle("Wyślij testowo")).not.toBeInTheDocument();
    expect(screen.getByText(/Historyczna lista odbiorców wycofanego digestu/)).toBeInTheDocument();
    expect(screen.getByText("Powiadomienia o nowych zapisach")).toBeInTheDocument();
    expect(screen.getByText("Krytyczne alerty płatności")).toBeInTheDocument();

    const emailInputs = screen.getAllByPlaceholderText("osoba@firma.pl");
    fireEvent.change(emailInputs[0], { target: { value: " NEW@Example.COM " } });
    fireEvent.change(screen.getAllByPlaceholderText("Marzena")[0], { target: { value: " New " } });
    fireEvent.click(screen.getAllByRole("button", { name: /Dodaj/i })[0]);

    await waitFor(() => {
      expect(createRecipientMock).toHaveBeenCalledWith("admin-token", {
        email: "new@example.com",
        name: "New",
        notification_type: "packaging_digest",
        active: true,
      });
      expect(toastSuccess).toHaveBeenCalledWith("Odbiorca dodany");
    });

    expect(getRecipientsMock).toHaveBeenCalledWith("admin-token", {
      notification_type: "commerce_payment_critical",
    });
  });
});
