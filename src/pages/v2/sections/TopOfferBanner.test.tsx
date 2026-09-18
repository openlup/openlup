import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import Navigation from "@/components/Navigation";

import { TopOfferBanner } from "./TopOfferBanner";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "pl" },
  }),
}));

vi.mock("@/lib/acquisitionRoutes", () => ({
  usePublicAcquisitionPath: () => "/skomponuj-pakiet",
}));

/**
 * Najgroźniejszy tryb porażki tej fali nie jest w samym pasku, tylko w tym, że
 * `Navigation` jest `fixed` i współdzielona przez wszystkie publiczne strony.
 * Gdyby offset paska trafił do niej na sztywno, treść przykryłaby nawigację
 * wszędzie poza stroną główną — daleko od miejsca zmiany. Te testy pilnują
 * kontraktu, który to blokuje: nawigacja czyta wysokość ze zmiennej, a zmienna
 * ma sens tylko tam, gdzie ktoś ją ustawi.
 */
describe("TopOfferBanner", () => {
  it("prowadzi do konfiguratora i pokazuje warunek oferty, nie samo -50%", () => {
    render(
      <MemoryRouter>
        <TopOfferBanner />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/skomponuj-pakiet");
    // Warunek musi jechać razem z rabatem: checkout liczy -50% tylko dla
    // dostawy 1 pakietu startowego, patrz `starterOfferPolicy`.
    expect(link.textContent).toContain("home:announcement.headline");
    const detail = screen.getByText("home:announcement.detail");
    expect(link).toContainElement(detail);
    expect(detail).toHaveAttribute("data-banner-detail");
    // Warunek jedzie z rabatem od `sm` w górę. Poniżej odpada na rzecz wezwania
    // do działania — decyzja właściciela, pełny warunek stoi w konfiguratorze.
    expect(detail).toHaveClass("hidden", "sm:inline");
  });

  it("trzyma wezwanie do działania na każdej szerokości", () => {
    render(
      <MemoryRouter>
        <TopOfferBanner />
      </MemoryRouter>,
    );

    const cta = screen.getByText("home:announcement.cta");
    expect(cta).not.toHaveClass("hidden");
  });

  it("nie zawija tekstu — od `sm` w górę pasek jest jedną linią", () => {
    render(
      <MemoryRouter>
        <TopOfferBanner />
      </MemoryRouter>,
    );

    // Wysokość paska jest stała, więc druga linia nie ma gdzie się zmieścić i
    // czyta się jak błąd. Ta asercja pilnuje regresji, która trafiła na
    // produkcję: kolumna zamiast wiersza na szerokich ekranach.
    const link = screen.getByRole("link");
    expect(link).toHaveClass("flex-col", "sm:flex-row");
    for (const span of Array.from(link.children)) {
      expect(span.className).not.toContain("flex-col");
    }
  });

  it("nie oddaje emoji czytnikom ekranu przed treścią oferty", () => {
    const { container } = render(
      <MemoryRouter>
        <TopOfferBanner />
      </MemoryRouter>,
    );

    const emoji = container.querySelector("[data-banner-emoji]");
    expect(emoji).not.toBeNull();
    expect(emoji).toHaveAttribute("aria-hidden", "true");
  });
});

describe("offset nawigacji", () => {
  it("czyta wysokość paska ze zmiennej, zamiast mieć ją wpisaną na sztywno", () => {
    const { container } = render(
      <MemoryRouter>
        <Navigation />
      </MemoryRouter>,
    );

    const nav = container.querySelector("nav");
    expect(nav?.className).toContain("top-[var(--announcement-height)]");
    expect(nav?.className).not.toContain("top-0");
  });
});
