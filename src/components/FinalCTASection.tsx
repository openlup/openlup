import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { LazyAutoplayVideo } from "@/components/LazyAutoplayVideo";
import { fadeUp } from "@/lib/animations";
import { lifestyleMotionLoop as dogsPlaying } from "#deployment-media";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

const FinalCTASection = () => {
  const { t } = useTranslation("home");
  const acquisitionPath = usePublicAcquisitionPath();

  return (
    <section className="relative py-[140px] px-6 lg:px-[72px] max-md:py-[80px] overflow-hidden bg-void">
      <LazyAutoplayVideo className="absolute inset-0 w-full h-full object-cover z-0" src={dogsPlaying} />
      <div className="absolute inset-0 bg-warm-coral/70 z-1" />
      <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="relative z-10 max-w-[1000px] mx-auto text-center">
        <p className="label-text text-white/80" style={{ letterSpacing: "0.18em" }}>{t("home:finalCta.label")}</p>
        <h2 className="font-display font-semibold text-[28px] sm:text-[34px] lg:text-[72px] text-white leading-[0.95] mt-4 whitespace-pre-line">{t("home:finalCta.heading")}</h2>
        <a href={acquisitionPath} className="inline-block pill-btn bg-white text-warm-coral font-semibold text-base-plus px-12 py-[18px] mt-11 hover:bg-offwhite hover:scale-[1.03] transition-all duration-200 shadow-lg">
          {t("home:finalCta.cta")}
        </a>
        <p className="font-body text-sm text-white/70 mt-4">{t("home:finalCta.note")}</p>
      </motion.div>
    </section>
  );
};

export default FinalCTASection;
