import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import ProtectedRoute from "@/components/admin/ProtectedRoute";
import { renderWithProviders } from "@/test/render";

const mockUseAuth = vi.fn();

vi.mock("@/lib/authContext", () => ({
  useAuth: () => mockUseAuth(),
}));

describe("ProtectedRoute", () => {
  it("shows a loading spinner while auth is resolving", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: true,
      isAdmin: false,
    });

    const { container } = renderWithProviders(
      <ProtectedRoute>
        <div>Admin content</div>
      </ProtectedRoute>,
    );

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("redirects unauthenticated users to the admin login page", () => {
    mockUseAuth.mockReturnValue({
      user: null,
      loading: false,
      isAdmin: false,
    });

    renderWithProviders(
      <ProtectedRoute>
        <div>Admin content</div>
      </ProtectedRoute>,
      { route: "/admin" },
    );

    expect(screen.queryByText("Admin content")).not.toBeInTheDocument();
  });

  it("renders children for authenticated admins", () => {
    mockUseAuth.mockReturnValue({
      user: { id: "admin-1" },
      loading: false,
      isAdmin: true,
    });

    renderWithProviders(
      <ProtectedRoute>
        <div>Admin content</div>
      </ProtectedRoute>,
    );

    expect(screen.getByText("Admin content")).toBeInTheDocument();
  });
});
