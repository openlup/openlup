import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

/**
 * Pasek promocyjny nad nawigacją — jedyne miejsce, w którym oferta startowa
 * (−50% na pierwszą dostawę) jest widoczna bez scrolla.
 *
 * Kolor: token `amber` pod tekstem w tokenie `void` — kontrast 6.9:1, czyli AA
 * z zapasem. Oba są w palecie, więc pasek nie wprowadza nowego koloru; wartości
 * celowo nie są tu powtórzone, żeby komentarz nie kłamał po przetokenowaniu.
 * `teal-deep` odpadł jako ten sam token co `void` — pasek zlewał się z hero;
 * `teal` odpadł, bo to kolor przycisku CTA.
 *
 * Emoji jest dekoracją: `aria-hidden`, żeby czytnik ekranu nie odczytywał
 * „prezent" przed treścią oferty. Ciepłe emoji (żółte, pomarańczowe) na tym tle
 * znikają — stąd czerwony prezent, a nie ✨ czy 🔥.
 *
 * Layout: `fixed` przy górnej krawędzi, wysokość z `--announcement-height`.
 * Wrapper strony ustawia tę zmienną (patrz `v2/Index.tsx`), a `Navigation`
 * czyta ją w swoim `top`, więc pasek i nawigacja nigdy się nie nakładają i
 * żadna inna strona nie zmienia layoutu. Warstwa `z-header` (30) siedzi pod
 * panelem menu mobilnego (`z-60`), który celowo przykrywa pasek na całą
 * wysokość ekranu.
 *
 * Treść jest zgodna z `starterOfferPolicy`: −50% dotyczy DOSTAWY 1 pakietu
 * startowego od `STARTER_MIN_CANS` = 14 puszek, nie całej subskrypcji. Warunek
 * jest w widocznym tekście, nie w gwiazdce — rabat bez warunku byłby
 * niezgodny z tym, co realnie nalicza checkout.
 */
export function TopOfferBanner() {
  const { t } = useTranslation("home");
  const acquisitionPath = usePublicAcquisitionPath();

  return (
    <div
      data-top-offer-banner
      className="fixed inset-x-0 top-0 z-header h-[var(--announcement-height)] bg-amber"
      style={{ height: "var(--announcement-height)", zIndex: 30 }}
    >
      {/* Jeden krój (`font-body`) i jeden rozmiar dla wszystkich trzech członów.
          Clash Display ma inną wysokość x i ciaśniejszy tracking niż Plus Jakarta,
          więc zmieszany z tekstem bazowym w pasku 40 px wyglądał jak inna linia
          bazowa, mimo że `items-center` centrował pudełka poprawnie. Waga i kolor
          niosą hierarchię zamiast kroju. */}
      <Link
        to={acquisitionPath}
        className="relative flex h-full flex-col items-center justify-center font-body text-void transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-void sm:flex-row sm:gap-2"
        style={{
          fontSize: "clamp(11px, 2vw, 14px)",
          lineHeight: 1.15,
          paddingInline: "12px",
        }}
      >
        {/* Emoji trzyma się hasła w jednym wierszu także poniżej `sm`, gdzie
            pasek jest kolumną — inaczej zjechałoby do własnej, trzeciej linii. */}
        <span className="flex items-center gap-2">
          <span aria-hidden="true" data-banner-emoji>
            🎁
          </span>
          <span className="whitespace-nowrap font-semibold">
            {t("home:announcement.headline")}
          </span>
        </span>
        {/* Warunek oferty odpada poniżej `sm`. Kolumna 375 px nie mieści hasła,
            warunku i wezwania naraz, a wezwanie jest tu ważniejsze: bez niego
            pasek nie wygląda na klikalny. Pełny warunek stoi w konfiguratorze,
            do którego pasek prowadzi. */}
        <span data-banner-detail className="hidden whitespace-nowrap sm:inline">
          {t("home:announcement.detail")}
        </span>
        <span className="whitespace-nowrap font-semibold underline" style={{ textDecoration: "underline" }}>
          {t("home:announcement.cta")}
        </span>
      </Link>
    </div>
  );
}
