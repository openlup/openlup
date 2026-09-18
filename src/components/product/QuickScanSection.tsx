import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";
import { Beef, Bug, Ban, Sprout, ClipboardCheck } from "lucide-react";
import { type LucideIcon } from "lucide-react";

interface Props {
  product: StorefrontItem;
}

interface ScanStat {
  icon: LucideIcon;
  value: string;
  labelKey: string;
}

const scanStats: Record<string, ScanStat[]> = {
  lamb: [
    { icon: Beef, value: "96%", labelKey: "catalog:product.proteinLabel" },
    { icon: Bug, value: "4", labelKey: "catalog:product.gutAgents" },
    { icon: Ban, value: "Zero", labelKey: "catalog:product.zeroGrain" },
    { icon: Sprout, value: "98%", labelKey: "catalog:product.lessLand" },
    { icon: ClipboardCheck, value: "FEDIAF", labelKey: "catalog:product.fediaf" },
  ],
  venison: [
    { icon: Beef, value: "95%", labelKey: "catalog:product.proteinLabel" },
    { icon: Bug, value: "4", labelKey: "catalog:product.gutAgents" },
    { icon: Ban, value: "Zero", labelKey: "catalog:product.zeroGrain" },
    { icon: Sprout, value: "98%", labelKey: "catalog:product.lessLand" },
    { icon: ClipboardCheck, value: "FEDIAF", labelKey: "catalog:product.fediaf" },
  ],
};

const QuickScanSection = ({ product }: Props) => {
  const stats = scanStats[product.slug] || scanStats.lamb;
  const { t } = useTranslation("catalog");

  return (
    <section className="bg-offwhite border-t border-border-light">
      <div className="max-w-[1280px] mx-auto px-6 lg:px-[72px] py-6">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={fadeUp}
          className="flex flex-wrap justify-center gap-6 lg:flex-nowrap lg:gap-10"
        >
          {stats.map((stat) => (
            <div key={stat.labelKey} className="flex items-center gap-2.5 min-w-0">
              <stat.icon className="w-5 h-5 shrink-0" style={{ color: product.color }} strokeWidth={1.5} />
              <div>
                <span
                  className="font-display font-semibold text-lg lg:text-xl leading-none"
                  style={{ color: product.color }}
                >
                  {stat.value}
                </span>
                <p className="font-body text-xxs text-text-on-light/60 leading-tight mt-0.5">
                  {t(stat.labelKey)}
                </p>
              </div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
};

export default QuickScanSection;
