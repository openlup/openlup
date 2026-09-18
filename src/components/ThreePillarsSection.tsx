import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { Microscope, ScanEye, Sprout } from "lucide-react";
import { Link } from "react-router-dom";
import { useLocalizedPath } from "@/lib/i18nRoutes";

const ThreePillarsSection = () => {
  const { t } = useTranslation("home");
  const lp = useLocalizedPath();

  const pillars = [
    {
      icon: Microscope,
      title: t("home:pillars.t1"),
      accentColor: "bg-teal-mint",
      borderColor: "border-t-teal-mint",
      iconColor: "text-teal-mint",
      body: t("home:pillars.b1"),
      link: { label: t("home:pillars.l1"), href: lp("science") },
    },
    {
      icon: ScanEye,
      title: t("home:pillars.t2"),
      accentColor: "bg-warm-coral",
      borderColor: "border-t-warm-coral",
      iconColor: "text-warm-coral",
      body: t("home:pillars.b2"),
      link: { label: t("home:pillars.l2"), href: "#products" },
    },
    {
      icon: Sprout,
      title: t("home:pillars.t3"),
      accentColor: "bg-sage-mint",
      borderColor: "border-t-sage-mint",
      iconColor: "text-sage-mint",
      body: t("home:pillars.b3"),
      link: { label: t("home:pillars.l3"), href: "#sustainability" },
    },
  ];

  return (
    <section className="bg-warm-cream py-[100px] px-6 lg:px-[72px] max-md:py-[60px]">
      <div className="max-w-[1280px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-14">
          <h2 className="font-display font-semibold text-[34px] lg:text-[56px] text-teal-dark leading-none">
            {t("home:pillars.heading")}
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-8">
          {pillars.map((p, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1, duration: 0.5 }}
              className="bg-white rounded-2xl border border-border shadow-xs overflow-hidden hover:shadow-lg transition-shadow duration-300"
            >
              <div className={`h-1.5 ${p.accentColor}`} />
              <div className="p-8">
                <div className={`w-12 h-12 rounded-xl ${p.accentColor}/10 flex items-center justify-center mb-5`}>
                  <p.icon className={`w-6 h-6 ${p.iconColor}`} strokeWidth={1.5} />
                </div>
                <h3 className="font-display font-semibold text-xl lg:text-[22px] text-teal-dark leading-tight">{p.title}</h3>
                <p className="font-body text-sm-plus text-charcoal/70 leading-[1.7] mt-4">{p.body}</p>
                {p.link.href.startsWith("#") ? (
                  <a href={p.link.href} className="inline-block font-body font-semibold text-sm text-primary hover:text-teal-dark transition-colors mt-5">{p.link.label}</a>
                ) : (
                  <Link to={p.link.href} className="inline-block font-body font-semibold text-sm text-primary hover:text-teal-dark transition-colors mt-5">{p.link.label}</Link>
                )}
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ThreePillarsSection;
