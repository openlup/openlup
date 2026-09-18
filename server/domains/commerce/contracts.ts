// Public contract surface for the outbox dispatcher. The dispatcher is a platform
// concern that lives under commerce for historical reasons; re-exporting the
// handler types through a `contracts` segment lets OTHER domains (subscription,
// accounting, …) implement an OutboxHandler without importing commerce internals
// (the architecture guardrail allows cross-domain imports only via
// contracts/ports/types/email segments). Types only — no runtime.

export type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
  OutboxHandlerRegistry,
} from "./outboxDispatchContracts.js";
