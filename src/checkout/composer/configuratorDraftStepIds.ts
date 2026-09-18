/**
 * How a saved configurator draft addresses the step it is parked on.
 *
 * The envelope stores each position twice: the number it has always stored, and
 * the step's identity. The number keeps older bundles working; the identity is
 * what survives a future reorder of the flow, when position 3 stops meaning
 * what it means today.
 *
 * `configuratorDraftCodec` is the only caller — it runs the write side in the
 * persisted state's `sanitize` and the read side around `load`/`loadResult`, so
 * the rest of the app only ever sees resolved numbers.
 */

import {
  stepIdAt,
  stepNumberOf,
  type ConfiguratorStepId,
} from "./configuratorStepOrder";

import type { ConfiguratorDraftEnvelope } from "./configuratorDraftCodec";

/**
 * Write side of the dual-write: derive both step ids from the numbers that are
 * being saved anyway. The numbers stay authoritative on disk for any bundle
 * that predates the ids, and the ids are recomputed from scratch on every write
 * so a rollback cannot leave a stale id paired with a newer number.
 */
export function withConfiguratorStepIds(
  envelope: ConfiguratorDraftEnvelope,
): ConfiguratorDraftEnvelope {
  const stepId = stepIdAt(envelope.step);
  const maxStepId = stepIdAt(envelope.maxStep);
  return {
    form: envelope.form,
    step: envelope.step,
    maxStep: envelope.maxStep,
    ...(stepId ? { stepId } : {}),
    ...(maxStepId ? { maxStepId } : {}),
  };
}

/**
 * Read side of the dual-write: prefer the id, fall back to the number.
 *
 * A missing id (draft written before this field existed) and an unrecognised
 * one (written by a newer bundle, or corrupted) both resolve to the stored
 * number, which is exactly today's behaviour. The ids are then dropped, so the
 * rest of the app keeps seeing the plain `{ form, step, maxStep }` shape and
 * only this module knows steps have identities.
 */
export function resolveConfiguratorDraftSteps(
  envelope: ConfiguratorDraftEnvelope,
): ConfiguratorDraftEnvelope {
  return {
    form: envelope.form,
    step: stepNumberFromId(envelope.stepId, envelope.step),
    maxStep: stepNumberFromId(envelope.maxStepId, envelope.maxStep),
  };
}

function stepNumberFromId(
  id: ConfiguratorStepId | undefined,
  fallback: number,
): number {
  if (typeof id !== "string") return fallback;
  const resolved = stepNumberOf(id);
  return resolved > 0 ? resolved : fallback;
}
