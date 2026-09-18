import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LanguageGate from "@/components/LanguageGate";
import { renderWithProviders } from "@/test/render";

const mockChangeLanguage = vi.fn();
const mockUseTranslation = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => mockUseTranslation(),
}));

// LanguageGate is language-only. The canonical/hreflang assertions that used to live
// here were deleted with the imperative head writer they covered: it raced <Seo />
// (Helmet) for the same tags, leaving two <link rel=canonical> per page and
// contradicting Seo on /legacy. Head ownership is now asserted in Seo.test.tsx.
describe("LanguageGate", () => {
  beforeEach(() => {
    localStorage.clear();
    document.head.innerHTML = "";
    document.documentElement.removeAttribute("lang");
    mockChangeLanguage.mockReset();
  });

  it("switches language and persists it", () => {
    mockUseTranslation.mockReturnValue({
      i18n: { language: "en", changeLanguage: mockChangeLanguage },
    });

    renderWithProviders(
      <LanguageGate lang="pl">
        <div>child content</div>
      </LanguageGate>,
      { route: "/how-it-works" },
    );

    expect(screen.getByText("child content")).toBeInTheDocument();
    expect(mockChangeLanguage).toHaveBeenCalledWith("pl");
    expect(localStorage.getItem("openlup-lang")).toBe("pl");
    expect(document.documentElement).toHaveAttribute("lang", "pl");
  });

  it("keeps the current language when it already matches", () => {
    mockUseTranslation.mockReturnValue({
      i18n: { language: "en", changeLanguage: mockChangeLanguage },
    });

    renderWithProviders(
      <LanguageGate lang="en">
        <div>child content</div>
      </LanguageGate>,
      { route: "/custom-page" },
    );

    expect(mockChangeLanguage).not.toHaveBeenCalled();
    expect(localStorage.getItem("openlup-lang")).toBeNull();
    expect(document.documentElement).toHaveAttribute("lang", "en");
  });

  it("writes no SEO links — <Seo /> is the only head owner", () => {
    mockUseTranslation.mockReturnValue({
      i18n: { language: "pl", changeLanguage: mockChangeLanguage },
    });

    renderWithProviders(
      <LanguageGate lang="pl">
        <div>child content</div>
      </LanguageGate>,
      { route: "/jak-to-dziala" },
    );

    expect(document.head.querySelectorAll('link[rel="canonical"]')).toHaveLength(0);
    expect(document.head.querySelectorAll('link[rel="alternate"]')).toHaveLength(0);
  });
});
