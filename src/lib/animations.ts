import { useReducedMotion, type Variants } from "framer-motion";

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: "easeOut" },
  },
};

/**
 * The full set of entry fadeUp props for `motion.*`; under `prefers-reduced-motion`
 * the element starts from its final state instead of animating.
 */
export function useFadeUpProps() {
  const shouldReduceMotion = useReducedMotion();
  return {
    initial: shouldReduceMotion ? false : ("hidden" as const),
    whileInView: "visible" as const,
    viewport: { once: true },
    variants: fadeUp,
  };
}
