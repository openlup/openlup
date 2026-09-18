import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import { useTranslation } from "react-i18next";
import {
  scienceProcessDiagram as entoProProcessPl,
  scienceProcessDiagramSecondaryLocale as entoProProcessEn,
  scienceIngredientPhoto as mushroomPhoto,
} from "#deployment-media";

const EntoProProcessSection = () => {
  const { t, i18n } = useTranslation("content");
  const entoProProcess = i18n.language === "pl" ? entoProProcessPl : entoProProcessEn;

  return (
    <section className="bg-[hsl(var(--sage-tint))] py-[100px] px-6 lg:px-[72px] max-md:py-[64px]">
      <div className="max-w-[1100px] mx-auto">
        {/* Text + photo grid */}
        <div className="grid lg:grid-cols-[55fr_45fr] gap-10 lg:gap-16 items-center">
          {/* Photo on mobile first, text on desktop first */}
          <motion.div
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
            variants={fadeUp}
            className="order-2 lg:order-1"
          >
            <h2 className="font-display font-semibold text-[32px] lg:text-[48px] text-charcoal leading-[0.95]">
              {t("content:entoProProcess.heading")}
            </h2>
            <div className="font-body text-base-plus text-charcoal/70 mt-6 leading-relaxed space-y-4 max-w-[520px]">
              <p>{t("content:entoProProcess.p1")}</p>
              <p>{t("content:entoProProcess.p2")}</p>
              <p>{t("content:entoProProcess.p3")}</p>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="order-1 lg:order-2"
          >
            <div className="rounded-[20px] overflow-hidden">
              <img
                src={mushroomPhoto}
                alt=""
                loading="lazy"
                decoding="async"
                width={1920}
                height={1080}
                className="w-full h-[280px] lg:h-[380px] object-cover"
              />
            </div>
          </motion.div>
        </div>

        {/* Process diagram — full width */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.15 }}
          className="mt-14 rounded-[20px] overflow-hidden"
        >
          <img
            src={entoProProcess}
            alt={t("content:entoProProcess.heading")}
            loading="lazy"
            decoding="async"
            width={1280}
            height={543}
            className="w-full h-auto"
          />
        </motion.div>
      </div>
    </section>
  );
};

export default EntoProProcessSection;
