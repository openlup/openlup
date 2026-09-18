import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import type { AudienceSegment } from "@/domains/catalog/audienceModel";
import { useFadeUpProps } from "@/lib/animations";
import { usePublicAcquisitionPath } from "@/lib/acquisitionRoutes";
import { Button } from "@/components/ui/button";

const BreedSummary = ({ breed }: { breed: AudienceSegment }) => {
  const fade = useFadeUpProps();
  const { t } = useTranslation("common");
  const acquisitionPath = usePublicAcquisitionPath();
  return (
    <section className="bg-offwhite px-6 lg:px-[72px] py-16 lg:py-20">
              <motion.div
                {...fade}
                className="max-w-[1280px] mx-auto"
              >
                <div className="rounded-card border border-border-light bg-warm-sand p-7 lg:p-10">
                  <p className="label-text text-copper mb-4">W skrócie: odpowiedź w 20 sekund</p>
                  <ul className="flex flex-col gap-4 max-w-[70ch]">
                    {breed.tldr.map((item) => (
                      <li key={item} className="relative pl-7 font-body text-sm-plus text-text-on-light leading-[1.6]">
                        <span className="absolute left-0.5 top-[9px] size-2.5 rounded-full bg-teal" aria-hidden="true" />
                        <span dangerouslySetInnerHTML={{ __html: item }} />
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-7 rounded-card border border-border-light bg-light-teal px-7 py-6 flex flex-wrap items-center justify-between gap-4">
                  <p className="font-body font-semibold text-sm-plus text-teal-dark max-w-[56ch]">
                    Wolisz od razu konkret dla swojego psa? Ankieta policzy porcję i dobierze receptury w dwie minuty.
                  </p>
                  <Button asChild variant="cta-marketing" size="section">
                    <a href={acquisitionPath}>{t("common:nav.apply")}</a>
                  </Button>
                </div>
              </motion.div>
            </section>
  );
};

export default BreedSummary;
