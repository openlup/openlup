import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { LazyAutoplayVideo } from "@/components/LazyAutoplayVideo";
import { Button } from "@/components/ui/button";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";
import {
  lifestyleMotionLoop as dogsPlaying,
  storyHeroCompressed as dogsPoster,
} from "#deployment-media";

/**
 * Last CTA przed footerem. Wcześniej miało warm-coral/75 overlay, którego
 * Maciej nie chciał (poza brand vibe).
 * Teraz: ciemny gradient z lekkim warm-coral akcentem od dołu, czysty white
 * tytuł, Button cta-marketing z naszego design systemu.
 */

export function FinalCTAv2() {
  const { t } = useTranslation("home");
  const acquisitionPath = usePublicAcquisitionPath();

  return (
    <section className="relative py-[140px] px-6 lg:px-[72px] max-md:py-[80px] overflow-hidden bg-void">
      <LazyAutoplayVideo
        className="absolute inset-0 w-full h-full object-cover z-0"
        src={dogsPlaying}
        poster={dogsPoster}
      />
      {/* Ciemny gradient od dołu zamiast coral overlay. Brand vibe: void/teal-dark */}
      <div className="absolute inset-0 z-1 bg-linear-to-t from-void via-void/70 to-void/30" />

      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.55 }}
        className="relative z-10 max-w-[1000px] mx-auto text-center"
      >
        <h2 className="font-display font-semibold text-[28px] sm:text-[34px] lg:text-[60px] text-white leading-[1.05] max-w-[820px] mx-auto">
          {t("home:finalCta.title")}
        </h2>
        <p className="font-body text-base-plus lg:text-lg text-white/80 leading-relaxed mt-6 max-w-[560px] mx-auto">
          {t("home:finalCta.body")}
        </p>
        <div className="mt-10">
          <Button asChild variant="cta-marketing" size="hero">
            <Link to={acquisitionPath}>{t("home:finalCta.cta")}</Link>
          </Button>
        </div>
      </motion.div>
    </section>
  );
}
