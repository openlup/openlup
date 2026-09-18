import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { Pill } from "@/components/brand/Pill";
import { Link2, Zap, Star, Activity, Leaf, Shield, FlaskConical } from "lucide-react";
import { useTranslation } from "react-i18next";

const cardDefs = [
  { icon: Link2, accentColor: "hsl(var(--warm-coral))", titleKey: "content:science.entopro.card1Title", bodyKey: "content:science.entopro.card1Body", tagKey: "content:science.entopro.card1Tag" },
  { icon: Zap, accentColor: "hsl(var(--warm-amber))", titleKey: "content:science.entopro.card2Title", bodyKey: "content:science.entopro.card2Body", tagKey: "content:science.entopro.card2Tag" },
  { icon: Star, accentColor: "hsl(var(--sage-mint))", titleKey: "content:science.entopro.card3Title", bodyKey: "content:science.entopro.card3Body", tagKey: "content:science.entopro.card3Tag" },
  { icon: Activity, accentColor: "hsl(var(--teal-mint))", titleKey: "content:science.entopro.card4Title", bodyKey: "content:science.entopro.card4Body", tagKey: "content:science.entopro.card4Tag" },
  { icon: Leaf, accentColor: "hsl(var(--soft-lavender))", titleKey: "content:science.entopro.card5Title", bodyKey: "content:science.entopro.card5Body", tagKey: "content:science.entopro.card5Tag" },
  { icon: Shield, accentColor: "hsl(var(--light-lavender))", titleKey: "content:science.entopro.card6Title", bodyKey: "content:science.entopro.card6Body", tagKey: "content:science.entopro.card6Tag" },
];

const statDefs = [
  { number: "98%", labelKey: "content:science.entopro.stat1", color: "hsl(var(--warm-coral))" },
  { number: "96%", labelKey: "content:science.entopro.stat2", color: "hsl(var(--teal-mint))" },
  { number: "85%+", labelKey: "content:science.entopro.stat3", color: "hsl(var(--sage-mint))" },
];

const compounds = [
  { name: "compoundTryptophan", entopro: "~200 mg", typical: "40–60 mg" },
  { name: "compoundMelatonin", entopro: "~6,7 mg", typical: "bardzo niska / śladowa" },
  { name: "compoundErgothioneine", entopro: "~50 mg", typical: "<5 mg" },
  { name: "compoundErgosterol", entopro: "~48 mg", typical: "brak / śladowe" },
  { name: "compoundChitin", entopro: "~12% s.m.", typical: "6–9% s.m.", modified: true },
];

const EntoProProofSection = () => {
  const { t } = useTranslation("content");

  return (
    <section className="bg-void py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[1100px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-14">
          <span className="inline-block label-text text-teal rounded-full border border-teal/30 px-4 py-1.5">{t("content:science.entopro.label")}</span>
          <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-offwhite leading-[0.95] mt-6">{t("content:science.entopro.heading")}</h2>
        </motion.div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mb-14">
          <div className="rounded-[20px] border border-sage-mint/30 bg-sage-mint/6 p-8 lg:p-10 max-w-[960px] mx-auto">
            <div className="flex items-center gap-3 mb-4">
              <FlaskConical size={22} className="text-sage-mint" />
              <span className="label-text text-sage-mint" style={{ letterSpacing: "0.14em" }}>FUNGI × PROTEIN</span>
            </div>
            <h3 className="font-display font-semibold text-[24px] lg:text-[32px] text-offwhite leading-[1.1]">{t("content:science.entopro.fungiTitle")}</h3>
            <p className="font-body text-base text-offwhite/65 leading-relaxed mt-4 max-w-[720px]">{t("content:science.entopro.fungiBody")}</p>
            <div className="mt-8 overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-offwhite/10">
                    <th className="text-left font-display font-semibold text-sm text-offwhite/50 py-3 pr-4 uppercase tracking-wider">Compound</th>
                    <th className="text-left font-display font-semibold text-sm text-sage-mint py-3 pr-4 uppercase tracking-wider">EntoPro™</th>
                    <th className="text-left font-display font-semibold text-sm text-offwhite/35 py-3 uppercase tracking-wider">{t("content:science.entopro.vsTypical")}</th>
                  </tr>
                </thead>
                <tbody>
                  {compounds.map((c) => (
                    <tr key={c.name} className="border-b border-offwhite/6">
                      <td className="font-display font-semibold text-sm-plus text-offwhite py-3 pr-4">{t(`content:science.entopro.${c.name}`)}</td>
                      <td className="font-body font-semibold text-sm-plus text-sage-mint py-3 pr-4">
                        {c.entopro}
                        {c.modified && <span className="text-xs text-offwhite/40 ml-1">({t("content:science.entopro.modifiedStructure")})</span>}
                      </td>
                      <td className="font-body text-sm-plus text-offwhite/40 py-3">{c.typical}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="font-body text-xs-plus text-offwhite/35 mt-6 leading-relaxed max-w-[680px]">{t("content:science.entopro.compoundNote")}</p>
          </div>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {cardDefs.map((card) => {
            const Icon = card.icon;
            return (
              <motion.div key={card.titleKey} initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="rounded-[16px] bg-charcoal/60 border border-offwhite/[0.07] p-7 flex flex-col border-t-[3px]" style={{ borderTopColor: card.accentColor }}>
                <Icon size={22} style={{ color: card.accentColor }} />
                <h3 className="font-display font-semibold text-lg text-offwhite mt-4">{t(card.titleKey)}</h3>
                <p className="font-body text-sm-plus text-offwhite/60 leading-relaxed mt-3 flex-1">{t(card.bodyKey)}</p>
                <Pill tone="mono" className="mt-5 border-offwhite/15 text-offwhite/50 self-start">{t(card.tagKey)}</Pill>
              </motion.div>
            );
          })}
        </div>

        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="flex justify-center gap-16 lg:gap-24 mt-16 max-md:gap-8">
          {statDefs.map((s) => (
            <div key={s.labelKey} className="text-center">
              <p className="font-display font-semibold text-[40px] lg:text-[56px] leading-none" style={{ color: s.color }}>{s.number}</p>
              <p className="mono-label text-offwhite/35 tracking-wider mt-2">{t(s.labelKey)}</p>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default EntoProProofSection;
