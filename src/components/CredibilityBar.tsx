import { useTranslation } from "react-i18next";
import { Dna, FlaskConical, Leaf } from "lucide-react";

/**
 * Trzy dowody marki: autorskie białko, lata badań, ślad węglowy.
 *
 *  • `band` (domyślny) — samodzielny pasek sekcyjny z własnym tłem i marquee
 *    na mobile. Zachowany bez zmian.
 *  • `hero`  — ten sam tekst i te same ikony wpięte pod CTA w hero: bez tła,
 *    bez separatorów, statycznie także na mobile. Ruchomy marquee tuż obok
 *    przycisku kradłby mu uwagę, więc na wąskich ekranach punktory po prostu
 *    się zawijają.
 */
type CredibilityBarProps = { variant?: "band" | "hero" };

const CredibilityBar = ({ variant = "band" }: CredibilityBarProps) => {
  const { t } = useTranslation("home");
  const items = [
    { text: t("home:credibility.item1"), icon: Dna },
    { text: t("home:credibility.item2"), icon: FlaskConical },
    { text: t("home:credibility.item3"), icon: Leaf },
  ];

  if (variant === "hero") {
    return (
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.text} className="flex items-center gap-2">
            <item.icon className="w-4 h-4 shrink-0 text-teal" strokeWidth={1.5} aria-hidden="true" />
            {/* /90, nie /80 jak w wariancie `band`: punktory w hero leżą niżej,
                gdzie lewostronny gradient jest już słaby i tekst konkuruje
                bezpośrednio z fakturą trawy na zdjęciu. */}
            <span className="font-body text-sm font-semibold text-offwhite/90">
              {item.text}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <section className="bg-white/10 backdrop-blur-md border-t border-white/10">
      <div className="hidden md:flex items-center justify-center gap-4 px-16 py-[18px]">
        {items.map((item, i) => (
          <span key={i} className="flex items-center gap-2">
            {i > 0 && <span className="text-white/20 mx-2">|</span>}
            <item.icon className="w-4 h-4 text-white/60" strokeWidth={1.5} />
            <span className="font-body font-semibold text-sm text-white/80">{item.text}</span>
          </span>
        ))}
      </div>
      <div className="md:hidden overflow-hidden py-4">
        <div className="flex animate-marquee whitespace-nowrap">
          {[...items, ...items].map((item, i) => (
            <span key={i} className="font-body font-semibold text-sm text-white/80 mx-6 shrink-0 flex items-center gap-2">
              <item.icon className="w-4 h-4 text-white/60" strokeWidth={1.5} />
              {item.text}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

export default CredibilityBar;
