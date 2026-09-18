/**
 * The configurator's step order, in one place.
 *
 * Lives in the composer rather than beside the page it renders because the
 * checkout draft persists a step and has to say which one it means: the draft
 * envelope, its id-addressed resolution and the legacy migration all read this,
 * and they are part of the published checkout surface. A published tree that
 * carried the draft codec but not the step order would not build.
 *
 * Ids only, on purpose. Labels and funnel names are presentation and belong to
 * the deployment that renders them, so the page layer's
 * `configuratorStepManifest` attaches those and adds `validateStaticStep` on
 * top. The order still has exactly one definition - this one.
 *
 * `profile` names the first step by what it collects (the profile a ration is
 * calculated from) rather than by what this deployment happens to sell, because
 * this surface is published.
 */
export const CONFIGURATOR_STEP_IDS = [
  "profile",
  "allergies",
  "flavors",
  "your_data",
  "package",
  "address",
  "payment",
] as const;

export type ConfiguratorStepId = (typeof CONFIGURATOR_STEP_IDS)[number];

/** Total number of configurator steps. */
export const TOTAL_CONFIGURATOR_STEPS: number = CONFIGURATOR_STEP_IDS.length;

/** Id of the 1-based `step`, or `null` when it addresses no step. */
export function stepIdAt(step: number): ConfiguratorStepId | null {
  return CONFIGURATOR_STEP_IDS[step - 1] ?? null;
}

/** 1-based position of `id` in the flow. */
export function stepNumberOf(id: ConfiguratorStepId): number {
  return CONFIGURATOR_STEP_IDS.indexOf(id) + 1;
}
