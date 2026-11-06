import { expect, it } from "vitest";
import { PLATFORM_EVENT_VOCABULARY, type OutboxHandler } from "../src/outbox/index.js";
import { checkReadiness, type ReadinessInput } from "../src/readiness/index.js";
it("exports neutral vocabulary and an abort-aware handler contract", () => {
  const handler: OutboxHandler = { eventType: "example.created", timeoutMs: 100, async handle(_, signal, context) { context?.setPhase("observe"); return signal.aborted ? { kind: "retry", reason: "aborted" } : { kind: "processed" }; } };
  expect(handler.eventType).toBe("example.created");
  expect(PLATFORM_EVENT_VOCABULARY.length).toBeGreaterThan(0);
  expect(new Set(PLATFORM_EVENT_VOCABULARY.map((v) => v.eventType)).size).toBe(PLATFORM_EVENT_VOCABULARY.length);
});

it("knows settlement facts while retaining explicit readiness ownership for an unhandled type", async () => {
  const settlement = PLATFORM_EVENT_VOCABULARY.find(entry => entry.eventType === "commerce.settlement.settled");
  expect(settlement).toEqual({ eventType: "commerce.settlement.settled", owner: "@openlup/core" });
  const facts: ReadinessInput = {
    candidate: { artifact: "candidate", configuration: "config", environment: "test", database: "database", schema: "schema" },
    inventoryComplete: true, loadedPackages: [{ name: "@openlup/core", version: "0.36.0", kind: "kernel" }],
    contributions: [], vocabulary: [settlement!], exemptions: [],
    bindings: { ports: {}, triggers: {}, routes: {}, env: {} },
    schemaProbe: { async observe() { throw new Error("unexpected_schema_probe"); } },
  };
  expect(await checkReadiness(facts)).toMatchObject({ state: "unsatisfied", issues: [
    { code: "OPENLUP_E_EVENT_UNHANDLED", subject: "commerce.settlement.settled" },
  ] });
  facts.exemptions = [{ pattern: settlement!.eventType, prefix: false, owner: "application",
    state: "ignored", reason: "Retain settlement facts without delivery in this composition." }];
  expect(await checkReadiness(facts)).toMatchObject({ state: "ready", issues: [] });
});
