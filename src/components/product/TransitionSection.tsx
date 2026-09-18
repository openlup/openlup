import { motion } from "framer-motion";
import { fadeUp } from "@/lib/animations";
import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";

interface Props {
  product: StorefrontItem;
}

const timeline = [
  { days: "Days 1–2", ratio: "25% openlup + 75% current", pct: 25 },
  { days: "Days 3–4", ratio: "50% / 50%", pct: 50 },
  { days: "Days 5–6", ratio: "75% openlup + 25% current", pct: 75 },
  { days: "Day 7+", ratio: "100% openlup", pct: 100 },
];

const defaultTips = [
  {
    title: "Watch the stool",
    body: "Loose stools in the first 2–3 days are normal. If they persist beyond day 5, slow down the transition.",
  },
  {
    title: "Don't mix kibble",
    body: "Wet food and kibble digest at different rates. If combining, serve in separate meals rather than mixing in one bowl.",
  },
  {
    title: "EntoPro™ helps",
    body: "The prebiotic chitin in EntoPro™ speeds up microbiome adaptation. Most dogs transition faster than average.",
  },
];

const TransitionSection = ({ product }: Props) => {
  const tips = product.transitionTips || defaultTips;
  const introText = product.transitionIntro ||
    "The EntoPro™ prebiotic speeds up microbiome adaptation vs conventional proteins. Most dogs transition faster than average.";

  return (
    <section id="transition" className="bg-void py-[100px] lg:py-[140px] px-6 lg:px-[72px]">
      <div className="max-w-[960px] mx-auto">
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp}>
          <p className="label-text mb-4" style={{ letterSpacing: "0.18em", color: product.color }}>
            SWITCHING FOOD
          </p>
          <h2 className="font-display font-semibold text-[28px] lg:text-[48px] text-offwhite leading-none">
            How to transition to openlup.
          </h2>
          <p className="font-body text-base text-text-on-dark/70 mt-4 max-w-[560px]">
            {introText}
          </p>
        </motion.div>

        {/* Allergy-specific callout */}
        {product.transitionCallout && (
          <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mt-8 max-w-[640px]">
            <div
              className="rounded-r-xl p-5 lg:p-6"
              style={{
                background: `${product.color}0f`,
                borderLeft: `4px solid ${product.color}`,
              }}
            >
              <p className="font-body text-sm-plus text-text-on-dark/80 leading-[1.7]">
                {product.transitionCallout}
              </p>
            </div>
          </motion.div>
        )}

        {/* Timeline */}
        <motion.div initial="hidden" whileInView="visible" viewport={{ once: true }} variants={fadeUp} className="mt-12 space-y-4">
          {timeline.map((step) => (
            <div key={step.days} className="flex items-center gap-5">
              <p className="font-display font-semibold text-base text-offwhite w-[90px] shrink-0">
                {step.days}
              </p>
              <div className="flex-1 h-[36px] rounded-full bg-surface overflow-hidden">
                <div
                  className="h-full rounded-full flex items-center px-4"
                  style={{ width: `${step.pct}%`, backgroundColor: `${product.color}cc` }}
                >
                  <span className="font-mono text-xxs text-void whitespace-nowrap">
                    {step.ratio}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </motion.div>

        {/* Tips */}
        <div className="grid sm:grid-cols-3 gap-5 mt-12">
          {tips.map((tip) => (
            <motion.div
              key={tip.title}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              variants={fadeUp}
              className="rounded-3xl bg-surface p-5 lg:p-6"
            >
              <h3 className="font-display font-semibold text-lg text-offwhite">{tip.title}</h3>
              <p className="font-body text-sm text-text-on-dark/70 leading-[1.6] mt-2">
                {tip.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TransitionSection;
