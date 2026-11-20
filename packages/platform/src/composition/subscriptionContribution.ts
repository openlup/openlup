import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { buildCapabilityContribution } from "./buildCapabilityContribution.js";

/** One selected subscription job; no second scheduler or automatic registration. */
export function createSubscriptionContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  run: (() => Promise<unknown>) | null;
  cadenceSeconds: number;
}) {
  if (!Number.isFinite(input.cadenceSeconds) || input.cadenceSeconds <= 0) throw new Error("subscription_cadence_invalid");
  const schedules = input.run ? [{ id: "subscriptions-renewal", cadenceSeconds: input.cadenceSeconds, run: input.run }] : [];
  const built = buildCapabilityContribution({
    id: "subscriptions",
    version: input.version,
    provides: ["./subscriptions", "./subscriptions/contracts"],
    dependsOn: [],
    requiredSchema: input.requiredSchema,
    ports: { run: input.run },
    includePort: Boolean,
    schedules,
  });
  return {
    contributions: [built.contribution],
    ports: input.run ? { "@openlup/platform/subscriptions:run": input.run } : {},
    triggers: built.triggers as { [k: string]: () => Promise<unknown> },
  };
}
