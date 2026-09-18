import { Link } from "react-router-dom";
import { Leaf } from "lucide-react";
import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { useTranslation } from "react-i18next";
import { useLocalizedPath } from "@/lib/i18nRoutes";

const SustainabilityBadge = () => {
  const { t } = useTranslation("catalog");
  const lp = useLocalizedPath();

  return (
    <section className="px-6 lg:px-[72px]" style={{ backgroundColor: "hsl(90, 27%, 92%, 0.4)" }}>
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true }}
        variants={fadeUp}
        className="max-w-[1080px] mx-auto flex items-center justify-center gap-4 py-5"
      >
        <Leaf size={20} className="text-sage-mint shrink-0" />
        <p className="font-body text-sm text-text-on-light/80 text-center">
          {t("catalog:product.sustainabilityText")}
        </p>
        <Link
          to={`${lp("science")}#sustainability`}
          className="font-body font-semibold text-xs-plus text-primary whitespace-nowrap hover:brightness-125 transition-colors shrink-0"
        >
          {t("catalog:product.sustainabilityLink")}
        </Link>
      </motion.div>
    </section>
  );
};

export default SustainabilityBadge;
