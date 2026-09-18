import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { Pill } from "@/components/brand/Pill";
import { FlaskConical, Beaker } from "lucide-react";
import { useTranslation } from "react-i18next";

const resultColors = [
  { border: "border-l-sage-mint", tagBg: "bg-sage-mint/10", tagText: "text-sage-mint", tagBorder: "border-sage-mint/30" },
  { border: "border-l-warm-coral", tagBg: "bg-warm-coral/10", tagText: "text-warm-coral", tagBorder: "border-warm-coral/30" },
  { border: "border-l-teal-mint", tagBg: "bg-teal-mint/10", tagText: "text-teal-mint", tagBorder: "border-teal-mint/30" },
  { border: "border-l-warm-amber", tagBg: "bg-warm-amber/10", tagText: "text-warm-amber", tagBorder: "border-warm-amber/30" },
  { border: "border-l-soft-lavender", tagBg: "bg-soft-lavender/10", tagText: "text-soft-lavender", tagBorder: "border-soft-lavender/30" },
];

const bgTints = ["bg-white", "bg-[hsl(var(--sage-tint))]", "bg-white", "bg-[hsl(var(--lavender-tint))]", "bg-white"];

const resultKeys = [
  { headlineKey: "content:science.trupet.result1Headline", bodyKey: "content:science.trupet.result1Body", tagKey: "content:science.trupet.result1Tag" },
  { headlineKey: "content:science.trupet.result2Headline", bodyKey: "content:science.trupet.result2Body", tagKey: "content:science.trupet.result2Tag" },
  { headlineKey: "content:science.trupet.result3Headline", bodyKey: "content:science.trupet.result3Body", tagKey: "content:science.trupet.result3Tag" },
  { headlineKey: "content:science.trupet.result4Headline", bodyKey: "content:science.trupet.result4Body", tagKey: "content:science.trupet.result4Tag" },
  { headlineKey: "content:science.trupet.result5Headline", bodyKey: "content:science.trupet.result5Body", tagKey: "content:science.trupet.result5Tag" },
];

const TruPetProofSection = () => {
  const { t } = useTranslation("content");

  return (
    <section className="bg-[hsl(var(--lavender-tint))] py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[1040px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-14">
          <span className="inline-block label-text text-charcoal/45 rounded-full border border-charcoal/15 px-4 py-1.5">{t("content:science.trupet.badge")}</span>
          <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-charcoal leading-[0.95] mt-6">
            {t("content:science.trupet.heading1")}<br />{t("content:science.trupet.heading2")}
          </h2>
          <p className="font-body text-lg text-charcoal/65 max-w-[560px] mx-auto mt-5 leading-relaxed">{t("content:science.trupet.body")}</p>
        </motion.div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="max-w-[720px] mx-auto mb-12">
          <div className="bg-white rounded-[16px] border border-charcoal/8 p-8 text-center shadow-xs">
            <p className="mono-label tracking-wider text-charcoal/35">{t("content:science.trupet.studyLabel")}</p>
            <h3 className="font-display font-semibold text-base lg:text-lg text-charcoal mt-3 leading-snug">{t("content:science.trupet.studyTitle")}</h3>
            <p className="font-mono text-xxs text-charcoal/40 mt-4 leading-relaxed">
              Lin C-Y, Alexander C, Steelman AJ, Warzecha CM, de Godoy MRC, Swanson KS.<br />
              J. Animal Sci. 2019;97(4):1586–1599. doi:10.1093/jas/skz064<br /><br />
              {t("content:science.trupet.studyDesign")}<br />
              {t("content:science.trupet.studyFunding")}
            </p>
          </div>
        </motion.div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="grid md:grid-cols-2 gap-5 max-w-[720px] mx-auto mb-12">
          <div className="bg-white/70 rounded-[16px] p-7 opacity-75">
            <FlaskConical size={22} className="text-charcoal/30" />
            <h4 className="font-display font-semibold text-lg text-charcoal mt-4">{t("content:science.trupet.probioticTitle")}</h4>
            <p className="font-body text-sm-plus text-charcoal/50 leading-relaxed mt-3 whitespace-pre-line">{t("content:science.trupet.probioticBody")}</p>
            <Pill tone="mono" className="mt-5 border-charcoal/15 text-charcoal/40">{t("content:science.trupet.probioticTag")}</Pill>
          </div>
          <div className="bg-white rounded-[16px] border-[1.5px] border-teal/30 p-7 shadow-[0_4px_24px_rgba(0,191,179,0.08)]">
            <Beaker size={22} className="text-teal" />
            <h4 className="font-display font-semibold text-lg text-charcoal mt-4">TruPet™ Postbiotic</h4>
            <p className="font-body text-sm-plus text-charcoal/65 leading-relaxed mt-3 whitespace-pre-line">{t("content:science.trupet.trupetBody")}</p>
            <Pill tone="mono" className="mt-5 border-teal/40 text-teal">{t("content:science.trupet.trupetTag")}</Pill>
          </div>
        </motion.div>

        <div className="max-w-[720px] mx-auto space-y-4">
          {resultKeys.map((r, i) => {
            const colors = resultColors[i];
            const bg = bgTints[i];
            return (
              <motion.div key={r.headlineKey} initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className={`${bg} rounded-[12px] border border-charcoal/6 border-l-4 ${colors.border} p-6 shadow-xs`}>
                <h4 className="font-display font-semibold text-base text-charcoal">{t(r.headlineKey)}</h4>
                <p className="font-body text-sm-plus text-charcoal/60 leading-relaxed mt-2">{t(r.bodyKey)}</p>
                <Pill tone="mono" className={`mt-4 ${colors.tagBg} ${colors.tagBorder} ${colors.tagText}`}>{t(r.tagKey)}</Pill>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default TruPetProofSection;
