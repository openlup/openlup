import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ProductFAQ from "@/components/product/ProductFAQ";
import { renderWithProviders } from "@/test/render";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en" },
  }),
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framerMotionMock");
  return createFramerMotionMock();
});

const faqs = [
  { question: "Is this a complete food?", answer: "Yes, it is complete food." },
  { question: "How should I serve it?", answer: "Serve at room temperature." },
];

describe("ProductFAQ", () => {
  it("keeps every answer in native details content for no-JS users", () => {
    const { container } = renderWithProviders(<ProductFAQ items={faqs} />);

    expect(faqs.length).toBeGreaterThan(0);
    expect(container.querySelectorAll("details")).toHaveLength(faqs.length);
    for (const faq of faqs) {
      const summary = screen.getByText(faq.question).closest("summary");
      expect(summary).not.toBeNull();
      expect(summary?.parentElement).toContainElement(screen.getByText(faq.answer));
    }
    expect(container.querySelector("button")).toBeNull();
  });
});
