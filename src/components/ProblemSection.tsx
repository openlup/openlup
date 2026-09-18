import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { lifestyleMealMoment as dogEating } from "#deployment-media";
import { fadeUp } from "@/lib/animations";

const ProblemSection = () => {
  const { t } = useTranslation("home");
  const stats = [
    { value: t("home:problem.stat1v"), label: t("home:problem.stat1l"), accent: false },
    { value: t("home:problem.stat2v"), label: t("home:problem.stat2l"), accent: true },
    { value: t("home:problem.stat3v"), label: t("home:problem.stat3l"), accent: false },
  ];

  return (
    <section className="bg-offwhite py-[140px] px-6 lg:px-[72px] max-md:py-[72px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
          <p className="label-text text-teal mb-7">{t("home:problem.label")}</p>
          <h2 className="font-display font-semibold text-[34px] lg:text-[56px] text-text-on-light leading-none max-w-[780px]">
            {t("home:problem.heading")}
          </h2>
          <p className="font-body text-sm text-text-muted mt-3">{t("home:problem.sub")}</p>
          <p className="font-body text-lg text-[#3A3A3A] leading-[1.75] max-w-[600px] mt-7">
            {t("home:problem.body")}
          </p>
        </motion.div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-8 mt-16 max-w-[800px]">
          {stats.map((stat, i) => (
            <div key={i} className={`text-center ${i > 0 ? "sm:border-l border-border-light" : ""}`}>
              <p className={`font-display font-semibold text-[28px] sm:text-[34px] lg:text-[56px] ${stat.accent ? "text-teal" : "text-text-on-light"}`}>{stat.value}</p>
              <p className="font-body text-sm sm:text-sm-plus text-text-muted">{stat.label}</p>
            </div>
          ))}
        </motion.div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mt-16">
          <div className="rounded-3xl overflow-hidden max-w-[1100px]">
            <img src={dogEating} alt="A dog enthusiastically eating from a bowl" className="w-full h-auto object-cover" loading="lazy" />
          </div>
          <p className="text-right font-body italic text-sm text-text-muted mt-3 max-w-[1100px]">
            {t("home:problem.quote")}
          </p>
        </motion.div>
      </div>
    </section>
  );
};

export default ProblemSection;