import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FAQv2 } from "./FAQv2";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("FAQv2 progressive enhancement", () => {
  it("ships every question and answer in native no-JS disclosure markup", () => {
    const html = renderToStaticMarkup(<FAQv2 />);

    expect(html.match(/<details/g)).toHaveLength(6);
    for (const suffix of ["8", "10", "11", "13", "1", "3"]) {
      expect(html).toContain(`home:faq.q${suffix}`);
      expect(html).toContain(`home:faq.a${suffix}`);
    }
    expect(html.match(/<details open=""/g)).toHaveLength(1);
    expect(html).not.toContain("opacity:0");
  });

  it("opens an answer through the native summary interaction", () => {
    render(<FAQv2 />);
    const summary = screen.getByText("home:faq.q10").closest("summary");
    const details = summary?.closest("details");

    expect(summary).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(summary!);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("home:faq.a10")).toBeVisible();
  });
});
