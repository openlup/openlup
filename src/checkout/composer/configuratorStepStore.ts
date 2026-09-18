import {
  getConfiguratorDraft,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  type ConfiguratorDraftScope,
  updateConfiguratorDraftStep,
} from "./configuratorDraftStore";

/**
 * Step adapters over the atomic configurator draft envelope.
 *
 * These deal in step NUMBERS only. The envelope also stores each position as a
 * step id and prefers it on read, but `configuratorDraftCodec` resolves that
 * back to a number before anything here sees it — so a future reorder of the
 * flow moves the numbers without any change on this side.
 */

export const getPersistedConfiguratorStep = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): number | null => getConfiguratorDraft(scope)?.step ?? null;

export const setPersistedConfiguratorStep = (
  step: number,
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  const maxStep = getConfiguratorDraft(scope)?.maxStep ?? step;
  updateConfiguratorDraftStep(step, maxStep, scope);
};

export const getPersistedConfiguratorMaxStep = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): number | null => getConfiguratorDraft(scope)?.maxStep ?? null;

export const setPersistedConfiguratorMaxStep = (
  maxStep: number,
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  const step = getConfiguratorDraft(scope)?.step ?? 1;
  updateConfiguratorDraftStep(step, maxStep, scope);
};

/** Reset navigation markers while preserving the user's form intent. */
export const clearConfiguratorStepPersistence = (
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void => {
  updateConfiguratorDraftStep(1, 1, scope);
};
