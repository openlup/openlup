import type { CommunicationPurpose } from "./types.js";

export type CommunicationPurposeClassification = "marketing" | "non-marketing";
export interface CommunicationPurposeDefinition<Purpose extends string = CommunicationPurpose> {
  readonly id: Purpose;
  readonly classification: CommunicationPurposeClassification;
}
/** Immutable, explicitly composed identifiers; registration is never permission. */
export interface CommunicationPurposeRegistry<Purpose extends string = CommunicationPurpose> {
  readonly purposes: readonly CommunicationPurposeDefinition<Purpose>[];
  has(value: unknown): value is Purpose;
  classification(purpose: Purpose): CommunicationPurposeClassification | undefined;
}
