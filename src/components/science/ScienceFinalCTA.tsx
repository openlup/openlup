import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { useTranslation } from "react-i18next";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

const ScienceFinalCTA = () => {
  const { t } = useTranslation("content");
  const acquisitionPath = usePublicAcquisitionPath();

  return (
    <section className="bg-void py-[120px] px-6 lg:px-[72px] max-md:py-[80px] relative overflow-hidden">
      <div className="absolute inset-0 bg-linear-to-b from-transparent via-warm-coral/3 to-transparent" />
      <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="max-w-[720px] mx-auto text-center relative z-10">
        <h2 className="font-display font-semibold text-[36px] lg:text-[52px] text-offwhite leading-[0.95]">
          {t("content:science.cta.heading1")}<br />{t("content:science.cta.heading2")}
        </h2>
        <p className="font-body text-lg text-offwhite/60 mt-5 whitespace-pre-line">{t("content:science.cta.body")}</p>
        <a href={acquisitionPath} className="inline-block pill-btn bg-warm-coral text-white font-semibold text-base px-12 py-[18px] mt-10 hover:brightness-110 hover:scale-[1.01] transition-all duration-200">
          {t("content:science.cta.button")}
        </a>
      </motion.div>
    </section>
  );
};

export default ScienceFinalCTA;
