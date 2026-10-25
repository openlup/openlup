import type { Contribution, RequiredSchema } from "@openlup/core/readiness";

/** One selected subscription job; no second scheduler or automatic registration. */
export function createSubscriptionContribution(input: {
  version: string;
  requiredSchema: RequiredSchema;
  run: (() => Promise<unknown>) | null;
  cadenceSeconds: number;
}) {
  if (!Number.isFinite(input.cadenceSeconds) || input.cadenceSeconds <= 0) throw new Error("subscription_cadence_invalid");
  const schedules = input.run ? [{ id: "subscriptions-renewal", cadenceSeconds: input.cadenceSeconds, run: input.run }] : [];
  const contribution: Contribution = {
    manifest: {
      name: "@openlup/platform", version: input.version, kind: "rail",
      module: { id: "subscriptions", kind: "capability", provides: ["./subscriptions", "./subscriptions/contracts"], dependsOn: [] },
      emits: [], handles: [], schedules: schedules.map(({ id, cadenceSeconds }) => ({ id, cadenceSeconds })),
      env: [], requiredPorts: ["run"], routes: [], requiredSchema: input.requiredSchema,
    }, handlers: [], schedules, routes: [],
  };
  return {
    contributions: [contribution],
    ports: input.run ? { "@openlup/platform/subscriptions:run": input.run } : {},
    triggers: Object.fromEntries(schedules.map(schedule => [`@openlup/platform/subscriptions:${schedule.id}`, schedule.run])),
  };
}
