import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { AudienceSegment } from "@/domains/catalog/audienceModel";
import { useFadeUpProps } from "@/lib/animations";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";
import { Button } from "@/components/ui/button";

const BreedClosingCta = ({ breed }: { breed: AudienceSegment }) => {
  const fade = useFadeUpProps();
  const { t } = useTranslation("common");
  const acquisitionPath = usePublicAcquisitionPath();
  return (
    <section className="bg-offwhite px-6 lg:px-[72px] pt-16 pb-20 lg:pt-20 lg:pb-24">
              <motion.div
                {...fade}
                className="max-w-[1280px] mx-auto rounded-card bg-void px-8 py-12 lg:px-14 lg:py-16 text-center"
              >
                <p className="label-text text-teal mb-4">Pakiet dla Twojego psa</p>
                <h2 className="font-display font-semibold text-display-sm lg:text-display-lg text-offwhite leading-tight mb-4">
                  Policzmy porcję dla Twojego psa
                </h2>
                <p className="font-body text-base text-offwhite/75 max-w-[56ch] mx-auto mb-8">
                  W ankiecie policzymy dokładną porcję dla Twojego psa i dobierzemy receptury do jego potrzeb. Zajmuje to dwie
                  minuty, a pakiet dopasowujemy do wagi, wieku i kondycji.
                </p>
                <Button asChild variant="cta-marketing" size="hero">
                  <a href={acquisitionPath}>{t("common:nav.apply")}</a>
                </Button>
              </motion.div>
            </section>
  );
};

export default BreedClosingCta;
