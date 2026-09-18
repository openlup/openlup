import { motion } from "framer-motion";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { fadeUp } from "@/lib/animations";
import FeedingGuideCompact from "./FeedingGuideCompact";

interface Props {
  product: StorefrontItem;
}

const FeedingGuideSection = ({ product }: Props) => {
  return (
    <section className="px-6 lg:px-[72px] py-[60px] lg:py-[80px]" style={{ backgroundColor: "#1a3a3a" }}>
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true }}
        variants={fadeUp}
        className="max-w-[720px] mx-auto"
      >
        <FeedingGuideCompact product={product} />
      </motion.div>
    </section>
  );
};

export default FeedingGuideSection;
