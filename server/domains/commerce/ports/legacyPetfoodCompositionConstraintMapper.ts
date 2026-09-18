import type { CompositionConstraint } from "../../../../src/domains/bundle/ports.js";
import type { CreateQuoteRequest } from "../../../../src/domains/commerce/contracts.js";

export const PETFOOD_COMPOSITION_CONSTRAINT_KIND = "petfood.kcal";
export const PETFOOD_COMPOSITION_CONSTRAINT_VERSION = 1;

export type LegacyPetfoodCompositionConstraint = Record<string, unknown>;

export function toCorePetfoodCompositionConstraint(
  persisted: unknown,
): CompositionConstraint {
  return {
    kind: PETFOOD_COMPOSITION_CONSTRAINT_KIND,
    version: PETFOOD_COMPOSITION_CONSTRAINT_VERSION,
    data: isRecord(persisted) ? persisted : {},
  };
}

export function toLegacyPetfoodCompositionConstraint(
  constraint: CompositionConstraint,
): LegacyPetfoodCompositionConstraint {
  if (
    constraint.kind !== PETFOOD_COMPOSITION_CONSTRAINT_KIND ||
    constraint.version !== PETFOOD_COMPOSITION_CONSTRAINT_VERSION
  ) {
    throw new Error("subscription_reprice_invalid_composition_constraint_envelope");
  }
  return constraint.data;
}

export function readLegacyPetfoodQuoteSizeConstraint(
  persisted: unknown,
): CreateQuoteRequest["sizeConstraint"] {
  if (persisted === null || persisted === undefined) return undefined;
  if (!isRecord(persisted)) {
    throw new Error("subscription_reprice_invalid_size_constraint");
  }
  // The live quote type is narrower than persisted JSON; keep the opaque record unchanged here.
  return persisted as CreateQuoteRequest["sizeConstraint"];
}

export function toLegacyPetfoodQuoteSizeConstraint(
  constraint: CompositionConstraint,
): CreateQuoteRequest["sizeConstraint"] {
  return readLegacyPetfoodQuoteSizeConstraint(toLegacyPetfoodCompositionConstraint(constraint));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
