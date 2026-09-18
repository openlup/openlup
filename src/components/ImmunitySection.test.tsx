import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ImmunitySection from "./ImmunitySection";
import { renderWithProviders } from "@/test/render";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "pl" },
  }),
}));
vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framerMotionMock");
  return createFramerMotionMock();
});
vi.mock("@/components/LazyViewportImage", () => ({
  LazyViewportImage: () => <img alt="" />,
}));

describe("ImmunitySection", () => {
  it("uses the accessible semantic foreground token for every statistic label", () => {
    renderWithProviders(<ImmunitySection />);

    for (const label of ["content:immunity.s1l", "content:immunity.s2l", "content:immunity.s3l"]) {
      expect(screen.getByText(label)).toHaveClass("text-muted-foreground");
    }
  });
});
