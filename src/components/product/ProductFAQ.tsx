import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { fadeUp } from "@/lib/animations";
import { ChevronDown } from "lucide-react";
import { detailsFromStorefrontSsgCatalog, type StorefrontSsgLocale } from "@/domains/catalog/storefrontSsgCatalog";
import { storefrontSsgDetails } from "#storefront-ssg-details";

export interface ProductFaqItem {
  question: string;
  answer: string;
}

type Props = { items: readonly ProductFaqItem[]; slug?: never; locale?: never }
  | { items?: never; slug: string; locale: StorefrontSsgLocale };

const ProductFAQ = (props: Props) => {
  const { t } = useTranslation("catalog");
  const items = props.items ?? detailsFromStorefrontSsgCatalog(storefrontSsgDetails, props.slug, props.locale)?.faq ?? [];

  return (
    // Jasne tło jak FAQv2 na homepage — odchodzimy od sekcji na bg-void.
    <section className="bg-light-teal py-[80px] px-6 lg:px-[72px] max-md:py-[56px]">
      <div className="max-w-[760px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="text-center mb-12">
          <h2 className="font-display font-semibold text-[28px] lg:text-[40px] text-teal-dark leading-none">
            {t("catalog:product.faq.heading")}
          </h2>
        </motion.div>

        <div className="space-y-3">
          {items.map((faq, i) => (
              <details
                key={i}
                className="group bg-white rounded-xl border border-border shadow-xs overflow-hidden"
              >
                <summary
                  className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-inset [&::-webkit-details-marker]:hidden"
                >
                  <span className="font-body font-semibold text-sm-plus lg:text-base text-teal-dark leading-snug">
                    {faq.question}
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className="w-5 h-5 text-muted-foreground shrink-0 transition-transform duration-200 group-open:rotate-180"
                  />
                </summary>
                <div className="px-6 pb-5 pt-0">
                  <p className="font-body text-sm lg:text-sm-plus text-charcoal/70 leading-[1.75]">
                    {faq.answer}
                  </p>
                </div>
              </details>
          ))}
        </div>
      </div>
    </section>
  );
};

export default ProductFAQ;
