import type { CommunicationPurpose } from "./contracts/types.js";
import type { CommunicationPurposeDefinition, CommunicationPurposeRegistry } from "./contracts/consent.js";

const builtins: readonly CommunicationPurposeDefinition[] = [
  { id: "transactional", classification: "non-marketing" },
  { id: "tester_program", classification: "non-marketing" },
  { id: "marketing_launch_offer", classification: "marketing" },
  { id: "marketing_newsletter", classification: "marketing" },
  { id: "subscription_dunning", classification: "non-marketing" },
  { id: "admin_notification", classification: "non-marketing" },
];

export function createCommunicationPurposeRegistry<const Purpose extends string = never>(
  additions: readonly CommunicationPurposeDefinition<Purpose>[] = [],
): CommunicationPurposeRegistry<CommunicationPurpose | Purpose> {
  const definitions = new Map<string, CommunicationPurposeDefinition<CommunicationPurpose | Purpose>>();
  for (const definition of [...builtins, ...additions]) {
    if (typeof definition.id !== "string" || !definition.id.trim() || definition.id !== definition.id.trim()
      || !["marketing", "non-marketing"].includes(definition.classification) || definitions.has(definition.id)) {
      throw new Error("communication_purpose_definition_invalid");
    }
    definitions.set(definition.id, Object.freeze({ id: definition.id, classification: definition.classification }));
  }
  return Object.freeze({
    purposes: Object.freeze([...definitions.values()]),
    has: (value: unknown): value is CommunicationPurpose | Purpose => typeof value === "string" && definitions.has(value),
    classification: (purpose: CommunicationPurpose | Purpose) => definitions.get(purpose)?.classification,
  });
}

export const defaultCommunicationPurposeRegistry = createCommunicationPurposeRegistry();
