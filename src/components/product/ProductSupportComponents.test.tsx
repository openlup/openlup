import { fireEvent, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { type ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import ProductAnchorNav from "@/components/product/ProductAnchorNav";
import SustainabilityBadge from "@/components/product/SustainabilityBadge";
import { renderWithProviders } from "@/test/render";

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framerMotionMock");
  return createFramerMotionMock();
});

class IntersectionObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

function renderInEnglish(ui: ReactElement) {
  const instance = createInstance();
  void instance.init({
    lng: "en",
    fallbackLng: false,
    initAsync: false,
    ns: ["catalog"],
    defaultNS: "catalog",
    resources: {
      en: {
        catalog: {
          product: {
            sustainabilityText: "Lower-impact ingredients",
            sustainabilityLink: "Learn about sustainability",
          },
        },
      },
    },
  });
  return renderWithProviders(<I18nextProvider i18n={instance}>{ui}</I18nextProvider>);
}

describe("product support components", () => {
  it("renders anchor nav and scrolls to selected section", () => {
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    const scrollSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    const section = document.createElement("section");
    section.id = "ingredients";
    section.getBoundingClientRect = () => ({ top: 300, bottom: 500, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
    document.body.appendChild(section);

    renderWithProviders(<ProductAnchorNav />);

    fireEvent.click(screen.getByRole("link", { name: "Ingredients" }));
    expect(scrollSpy).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });

    section.remove();
    scrollSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders sustainability badge with localized science link", () => {
    renderInEnglish(<SustainabilityBadge />);

    expect(screen.getByText("Lower-impact ingredients")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Learn about sustainability" })).toHaveAttribute("href", "/how-it-works#sustainability");
  });
});
