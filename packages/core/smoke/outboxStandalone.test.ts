import { expect, it } from "vitest";
import { PLATFORM_EVENT_VOCABULARY, type OutboxHandler } from "../src/outbox/index.js";
it("exports neutral vocabulary and an abort-aware handler contract", () => {
  const handler: OutboxHandler = { eventType: "example.created", timeoutMs: 100, async handle(_, signal, context) { context?.setPhase("observe"); return signal.aborted ? { kind: "retry", reason: "aborted" } : { kind: "processed" }; } };
  expect(handler.eventType).toBe("example.created");
  expect(PLATFORM_EVENT_VOCABULARY.length).toBeGreaterThan(0);
  expect(new Set(PLATFORM_EVENT_VOCABULARY.map((v) => v.eventType)).size).toBe(PLATFORM_EVENT_VOCABULARY.length);
});
