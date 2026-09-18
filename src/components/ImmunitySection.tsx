import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Leaf, Heart, Dna } from "lucide-react";

import { Button } from "@/components/ui/button";
import { LazyViewportImage } from "@/components/LazyViewportImage";
import { fadeUp } from "@/lib/animations";
import { useLocalizedPath } from "@/lib/i18nRoutes";
import { lifestyleFieldCompanion as fieldDalmatian } from "#deployment-media";

/**
 * "Jak to działa" — sekcja odporności / jelit (Visual ID Figma "Desktop-1").
 *
 * Redesign (Maciej): z ciemnej sekcji z wideo na jasny layout — eyebrow +
 * nagłówek + 3 statystyki z ikonami + CTA, na kremowym tle z pasem zdjęcia
 * pola z psami u dołu. Copy i statystyki bez zmian (jak na staging); nowość
 * to eyebrow „Jak to działa" i CTA „dowiedz się więcej" do strony nauki.
 *
 * Współdzielona przez homepage V2 i (legacy) Index.
 */

const stats = [
  { icon: Leaf, valueKey: "content:immunity.s1v", labelKey: "content:immunity.s1l" },
  { icon: Heart, valueKey: "content:immunity.s2v", labelKey: "content:immunity.s2l" },
  { icon: Dna, valueKey: "content:immunity.s3v", labelKey: "content:immunity.s3l" },
] as const;

const ImmunitySection = () => {
  const { t } = useTranslation("content");
  const lp = useLocalizedPath();

  return (
    <section className="relative overflow-hidden bg-field-haze">
      <div className="relative z-10 max-w-[1280px] mx-auto px-6 lg:px-[72px] pt-[100px]">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, amount: 0.3 }}
          variants={fadeUp}
          className="text-center max-w-[760px] mx-auto"
        >
          <h2 className="font-display font-semibold text-[32px] lg:text-[52px] text-teal-dark leading-[1.05]">
            {t("content:immunity.heading")}
          </h2>
          <p className="font-body text-lg text-charcoal/70 leading-[1.75] mt-6">
            {t("content:immunity.body")}
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-10 lg:gap-8 mt-16">
          {stats.map((stat, i) => (
            <motion.div
              key={stat.valueKey}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.12, duration: 0.5 }}
              className="text-center"
            >
              <stat.icon className="w-10 h-10 mx-auto mb-4 text-teal" strokeWidth={1.5} />
              <p className="font-display font-semibold text-[30px] lg:text-[40px] leading-none text-teal-dark">
                {t(stat.valueKey)}
              </p>
              <p className="font-body text-sm-plus text-muted-foreground mt-3 max-w-[240px] mx-auto">
                {t(stat.labelKey)}
              </p>
            </motion.div>
          ))}
        </div>

        <div className="text-center mt-14">
          <Button asChild variant="cta-teal" size="section">
            <Link to={lp("science")}>{t("content:immunity.cta")}</Link>
          </Button>
        </div>
      </div>

      {/* Pole z dalmatyńczykiem jako tło sekcji (Visual ID Desktop-1).
          Obraz (pełny kadr, z wbudowanym zanikiem alpha u góry) jest wciągany
          ujemnym marginesem POD treść (z-0 < z-10), tak że statystyki i CTA
          siedzą NA polu — dokładnie jak w Figmie — a dalmatyńczyk jest niżej.
          -mt w % szerokości → responsywne. Wtopienie góry płynne dzięki alfie. */}
      <LazyViewportImage
        src={fieldDalmatian}
        alt=""
        aria-hidden="true"
        width={1440}
        height={861}
        className="relative z-0 block w-full h-auto -mt-[17%]"
      />
    </section>
  );
};

export default ImmunitySection;
