import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { fadeUp } from "@/lib/animations";
import { lifestyleOwnerPortraitCompressed as womanWithAkita } from "#deployment-media";
import { useLocalizedPath } from "@/lib/i18nRoutes";

const MushroomIcon = () => (
  <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7 shrink-0">
    {/* Champignon cap - rounded dome */}
    <path
      d="M6 18C6 11 10 6 16 6C22 6 26 11 26 18"
      stroke="#f5f0eb"
      strokeWidth="1.5"
      strokeLinecap="round"
      fill="none"
    />
    {/* Cap bottom rim */}
    <path d="M6 18C6 18 8 20 16 20C24 20 26 18 26 18" stroke="#f5f0eb" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    {/* Gills under cap */}
    <path d="M11 18.5L12 19.5" stroke="#f5f0eb" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
    <path d="M16 18.5L16 20" stroke="#f5f0eb" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
    <path d="M21 18.5L20 19.5" stroke="#f5f0eb" strokeWidth="1" strokeLinecap="round" opacity="0.5" />
    {/* Thick stem */}
    <path d="M13 20L13.5 27" stroke="#f5f0eb" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    <path d="M19 20L18.5 27" stroke="#f5f0eb" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    {/* Stem base - wider */}
    <path d="M13 27C13 27 14 28.5 16 28.5C18 28.5 19 27 19 27" stroke="#f5f0eb" strokeWidth="1.5" strokeLinecap="round" fill="none" />
  </svg>
);

const SustainabilitySection = () => {
  const { t } = useTranslation("content");
  const lp = useLocalizedPath();

  return (
    <section id="sustainability" className="relative min-h-[500px] lg:min-h-[600px] overflow-hidden">
      {/* Background image */}
      <img
        src={womanWithAkita}
        alt=""
        className="absolute inset-0 w-full h-full object-cover"
        loading="lazy"
        decoding="async"
        width={1280}
        height={853}
      />
      {/* Dark overlay — mocniejszy i bardziej równomierny, żeby tekst i karty
          po prawej (nad jaśniejszą częścią zdjęcia) były czytelne. */}
      <div className="absolute inset-0 bg-linear-to-r from-black/85 via-black/72 to-black/58" />

      {/* Content */}
      <div className="relative z-10 max-w-[1280px] mx-auto px-6 lg:px-[72px] py-[80px] lg:py-[100px] min-h-[500px] lg:min-h-[600px] flex items-center">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-16 w-full items-center">
          {/* Left column: heading + CTA */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
          >
            <p
              className="label-text text-sage-mint mb-4"
              style={{ letterSpacing: "0.18em" }}
            >
              {t("content:sustainability.label")}
            </p>

            <h2 className="font-display font-semibold text-[28px] lg:text-[48px] text-white leading-[1.1]">
              {t("content:sustainability.heading")}
            </h2>

            {t("content:sustainability.body") && (
              <p className="font-body text-base-plus text-white/85 leading-[1.75] mt-5">
                {t("content:sustainability.body")}
              </p>
            )}

            <Link
              to={lp("ourStory")}
              className="inline-block pill-btn bg-white/90 text-void font-semibold text-sm-plus px-8 py-[12px] hover:bg-white transition-all duration-200 shadow-lg mt-8"
            >
              {t("content:sustainability.cta")}
            </Link>
          </motion.div>

          {/* Right column: stats + mushroom box */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15, duration: 0.5 }}
            className="flex flex-col gap-5"
          >
            {/* Stats label */}
            <p className="font-body text-xs-plus text-white/70 uppercase tracking-wider">
              {t("content:sustainability.statsLabel")}
            </p>

            {/* Two stat cards */}
            <div className="grid grid-cols-1 min-[480px]:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-black/35 backdrop-blur-sm border border-white/15 p-6 text-center">
                <p className="font-display font-semibold text-[36px] lg:text-[48px] text-sage-mint leading-none">
                  {t("content:sustainability.stat2v")}
                </p>
                <p className="font-body text-xs-plus lg:text-sm text-white/80 mt-2 leading-snug">
                  {t("content:sustainability.stat2l")}
                </p>
              </div>
              <div className="rounded-2xl bg-black/35 backdrop-blur-sm border border-white/15 p-6 text-center">
                <p className="font-display font-semibold text-[36px] lg:text-[48px] text-sage-mint leading-none">
                  {t("content:sustainability.stat3v")}
                </p>
                <p className="font-body text-xs-plus lg:text-sm text-white/80 mt-2 leading-snug">
                  {t("content:sustainability.stat3l")}
                </p>
              </div>
            </div>

            {/* Mushroom fact box */}
            <div className="rounded-2xl bg-black/35 backdrop-blur-sm border border-white/15 p-6 flex gap-4 items-start">
              <div className="w-12 h-12 rounded-xl bg-sage-mint/20 flex items-center justify-center shrink-0 mt-0.5">
                <MushroomIcon />
              </div>
              <div>
                <p className="font-display font-semibold text-base text-white leading-tight">
                  {t("content:sustainability.mushroomTitle")}
                </p>
                <p className="font-body text-sm text-white/80 leading-[1.7] mt-2">
                  {t("content:sustainability.mushroomBody")}
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default SustainabilitySection;
