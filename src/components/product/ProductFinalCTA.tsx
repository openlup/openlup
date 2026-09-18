import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontSsgSummaryItem } from "@/domains/catalog/storefrontSsgCatalog";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";

interface Props {
  product: Pick<StorefrontSsgSummaryItem, "name">;
}

const ProductFinalCTA = ({ product }: Props) => {
  const { t } = useTranslation("catalog");
  const acquisitionPath = usePublicAcquisitionPath();
  const productName = product.name;

  return (
    // bg-void token zamiast hardcoded #1a6b6a — spójnie z FinalCTAv2 na homepage.
    <section className="py-[100px] lg:py-[140px] px-6 lg:px-[72px] bg-void">
      <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="max-w-[1000px] mx-auto text-center">
        <h2 className="font-display font-semibold text-[28px] sm:text-[34px] lg:text-[56px] text-white leading-[0.95]">
          {t("catalog:product.readyToTry")}<br />{productName}?
        </h2>

        <p className="font-body text-base text-white/70 mt-4">
          {t("catalog:product.firstBoxOnUs")}
        </p>

        <Button asChild variant="cta-marketing" size="section" className="mt-8">
          <a href={acquisitionPath}>{t("catalog:product.getFreeSamples")}</a>
        </Button>

      </motion.div>
    </section>
  );
};

export default ProductFinalCTA;
