import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * FAQ v2 — kopia legacy `FAQSection` z 5 nowymi pytaniami pod survey-first
 * commerce: ankieta, miesięczny koszt, anulowanie, wiele psów, BLIK/faktura.
 * Bottom-of-page dla SEO/GEO/LLM ranking — Maciej zaznaczył to wprost.
 */

interface FaqItem {
  qKey: string;
  aKey: string;
}

// Display order, not key order: the functional-food / gut-health questions are
// shown first, ahead of the original survey-first commerce set. Reorder here —
// do not renumber the i18n keys.
const faqs: FaqItem[] = [
  { qKey: "home:faq.q8", aKey: "home:faq.a8" },
  { qKey: "home:faq.q10", aKey: "home:faq.a10" },
  { qKey: "home:faq.q11", aKey: "home:faq.a11" },
  { qKey: "home:faq.q13", aKey: "home:faq.a13" },
  { qKey: "home:faq.q1", aKey: "home:faq.a1" },
  { qKey: "home:faq.q3", aKey: "home:faq.a3" },
];

export function FAQv2() {
  const { t } = useTranslation("home");

  return (
    <section id="faq" className="bg-light-teal py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[760px] mx-auto">
        <div className="text-center mb-12">
          <h2 className="font-display font-semibold text-[34px] lg:text-[52px] text-teal-dark leading-none">
            {t("home:faq.heading")}
          </h2>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, index) => (
              <details
                key={faq.qKey}
                open={index === 0}
                className="group bg-white rounded-xl border border-border shadow-xs overflow-hidden"
              >
                <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
                  <span className="font-body font-semibold text-sm-plus lg:text-base text-teal-dark leading-snug">
                    {t(faq.qKey)}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="w-5 h-5 text-muted-foreground shrink-0 transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <div className="px-6 pb-5 pt-0">
                  <p className="font-body text-sm lg:text-sm-plus text-charcoal/70 leading-[1.7]">
                    {t(faq.aKey)}
                  </p>
                </div>
              </details>
          ))}
        </div>
      </div>
    </section>
  );
}
