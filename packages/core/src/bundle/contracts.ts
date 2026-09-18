import type { BundleLineRef, CompositionConstraint } from "./ports.js";

/** @beta */
export type {
  BundleLineRef,
  CompositionConstraint,
  CompositionRulesPort,
} from "./ports.js";

/** @beta */
export interface Bundle {
  coreLines: BundleLineRef[];
  addonLines: BundleLineRef[];
  constraint: CompositionConstraint;
}
