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
 * Komplet propsów wejściowego fadeUp dla `motion.*`; przy `prefers-reduced-motion`
 * element startuje od stanu końcowego zamiast animować (DESIGN.md §7).
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
