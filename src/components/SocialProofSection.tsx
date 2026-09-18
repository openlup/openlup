import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { Award, GraduationCap, ShieldCheck } from "lucide-react";

const SocialProofSection = () => {
  const { t } = useTranslation("home");

  const proofs = [
    { icon: Award, title: t("home:socialProof.t1"), desc: t("home:socialProof.d1"), color: "text-warm-coral" },
    { icon: GraduationCap, title: t("home:socialProof.t2"), desc: t("home:socialProof.d2"), color: "text-teal-mint" },
    { icon: ShieldCheck, title: t("home:socialProof.t3"), desc: t("home:socialProof.d3"), color: "text-sage-mint" },
  ];

  return (
    <section className="bg-warm-cream py-[100px] px-6 lg:px-[72px] max-md:py-[60px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-14">
          <h2 className="font-display font-semibold text-[34px] lg:text-[56px] text-teal-dark leading-none">{t("home:socialProof.heading")}</h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {proofs.map((p, i) => (
            <motion.div key={i} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.1, duration: 0.5 }} className="bg-white rounded-2xl border border-border p-6 text-center shadow-xs hover:shadow-md transition-shadow duration-300">
              <p.icon className={`w-10 h-10 mx-auto mb-4 ${p.color}`} strokeWidth={1.5} />
              <h3 className="font-display font-semibold text-base lg:text-lg text-teal-dark leading-tight">{p.title}</h3>
              <p className="font-body text-xs-plus text-muted-foreground mt-2">{p.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default SocialProofSection;
