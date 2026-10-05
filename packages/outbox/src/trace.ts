import type { OutboxHandler, OutboxEventRow, OutboxHandlerOutcome, OutboxHandlerExecutionContext } from "./contracts.js";
const SAFE_MESSAGE_MAX_CHARS = 300;
export class OutboxHandlerExecutionTrace implements OutboxHandlerExecutionContext {
  private lastPhase: string | undefined;

  setPhase(phase: string): void {
    const sanitized = phase.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 48);
    if (sanitized) this.lastPhase = sanitized;
  }

  timeoutReason(): string {
    return this.lastPhase ? `outbox_handler_timeout:${this.lastPhase}` : "outbox_handler_timeout";
  }

  qualifyTimeout(outcome: OutboxHandlerOutcome): OutboxHandlerOutcome {
    return this.lastPhase && outcome.kind === "retry" && outcome.reason === "outbox_handler_timeout"
      ? { ...outcome, reason: this.timeoutReason() }
      : outcome;
  }
}

export async function executeHandler(
  handler: OutboxHandler,
  row: OutboxEventRow,
): Promise<OutboxHandlerOutcome> {
  const controller = new AbortController();
  const execution = new OutboxHandlerExecutionTrace();
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  let backstopTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Abort is the primary timeout mechanism (handlers must honor the
    // signal); the race is only a backstop for non-abortable code, firing
    // 500ms later so abort-aware handlers get to settle first.
    const backstop = new Promise<OutboxHandlerOutcome>((resolve) => {
      backstopTimer = setTimeout(
        () => resolve({ kind: "retry", reason: execution.timeoutReason() }),
        handler.timeoutMs + 500,
      );
    });
    abortTimer = setTimeout(() => controller.abort(), handler.timeoutMs);
    const outcome = await Promise.race([handler.handle(row, controller.signal, execution), backstop]);
    return execution.qualifyTimeout(outcome);
  } catch (error) {
    return { kind: "retry", reason: safeMessage(error) };
  } finally {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (backstopTimer !== undefined) clearTimeout(backstopTimer);
  }
}


function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, SAFE_MESSAGE_MAX_CHARS); }
