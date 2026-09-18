import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { lifestyleOwnerPortraitCompressed as womanWithAkita } from "#deployment-media";
import { useTranslation } from "react-i18next";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

const ScienceHero = () => {
  const { t } = useTranslation("content");
  const acquisitionPath = usePublicAcquisitionPath();

  return (
    <section className="relative bg-void pt-[160px] pb-[120px] px-6 lg:px-[72px] max-md:pt-[120px] max-md:pb-[80px] overflow-hidden">
      <div className="absolute inset-0">
        <img
          src={womanWithAkita}
          alt=""
          width={1280}
          height={853}
          decoding="async"
          {...{ fetchpriority: "high" }}
          className="w-full h-full object-cover opacity-15"
        />
        <div className="absolute inset-0 bg-linear-to-b from-[hsl(var(--void))] via-[hsl(var(--void))/0.85] to-[hsl(var(--void))]" />
      </div>
      <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="max-w-[840px] mx-auto text-center relative z-10">
        <h1 className="font-display font-semibold text-[40px] lg:text-[64px] text-offwhite leading-[0.95]">
          {t("content:science.hero.heading1")}<br />{t("content:science.hero.heading2")}
        </h1>
        <p className="font-body text-lg lg:text-xl text-offwhite/65 max-w-[600px] mx-auto mt-6 leading-relaxed">
          {t("content:science.hero.body")}
        </p>
        <a href={acquisitionPath} className="inline-block pill-btn bg-warm-coral text-white font-semibold text-sm-plus px-8 py-[14px] mt-10 hover:brightness-110 hover:scale-[1.01] transition-all duration-200">
          {t("content:science.hero.cta")}
        </a>
      </motion.div>
    </section>
  );
};

export default ScienceHero;
