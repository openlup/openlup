import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AppRuntimeEffects from "@/routes/AppRuntimeEffects";

vi.mock("@/components/Analytics", () => ({
  default: () => <div data-testid="analytics" />,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => <div data-testid="sonner" />,
}));

vi.mock("@/components/ui/toaster", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

describe("AppRuntimeEffects", () => {
  it("mounts runtime-only UI effects", () => {
    render(<AppRuntimeEffects />);

    expect(screen.getByTestId("toaster")).toBeInTheDocument();
    expect(screen.getByTestId("sonner")).toBeInTheDocument();
    expect(screen.getByTestId("analytics")).toBeInTheDocument();
  });
});
