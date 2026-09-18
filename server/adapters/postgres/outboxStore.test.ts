import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { createPostgresOutboxStore } from "./outboxStore.js";
import { runOutboxDispatchWorker } from "../../domains/commerce/outboxDispatchWorker.js";

interface RecordedClient {
  queries: Array<{ text: string; values?: unknown[] }>;
  released: boolean;
}

function stubPool(opts: { failRpc?: string; pendingEvent?: boolean } = {}) {
  const clients: RecordedClient[] = [];
  let ended = false;
  let claimCount = 0;
  return {
    clients,
    wasEnded: () => ended,
    pool: {
      async connect() {
        const record: RecordedClient = { queries: [], released: false };
        clients.push(record);
        return {
          async query(text: string, values?: unknown[]) {
            record.queries.push({ text, values });
            if (opts.failRpc && text.includes(`"${opts.failRpc}"`)) {
              const error = new Error("rail down") as Error & { code?: string };
              error.code = "P0001";
              throw error;
            }
            if (text.includes("SELECT EXISTS")) return { rows: [{ present: opts.pendingEvent === true }] };
            if (text.includes("outbox_claim_batch")) return { rows: claimCount++ === 0 ? [eventRow()] : [] };
            if (text.includes("outbox_mark_processed")) return { rows: [{ outbox_mark_processed: true }] };
            if (text.includes("outbox_mark_failed")) return { rows: [{ outbox_mark_failed: "snoozed" }] };
            if (text.includes("outbox_release_unprocessed")) return { rows: [{ outbox_release_unprocessed: 2 }] };
            return { rows: [] };
          },
          release() {
            record.released = true;
          },
        };
      },
      async end() {
        ended = true;
      },
    } as never,
  };
}

function eventRow() {
  return {
    id: "evt-1",
    created_at: "2026-06-12T10:00:00Z",
    available_at: "2026-06-12T10:00:00Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "order-1",
    event_type: "commerce.order_draft.created",
    idempotency_key: "key-1",
    status: "processing",
    attempts: 1,
    payload: {},
    error: null,
    metadata: { claimToken: "token-1" },
  };
}

describe("Postgres outbox store adapter", () => {
  it("probes status-authoritative unresolved terminal work without claiming it", async () => {
    const { pool, clients } = stubPool({ pendingEvent: true });
    const store = createPostgresOutboxStore({ connectionString: "x" }, { poolFactory: () => pool });

    await expect(store.hasPendingEventType?.("tester.feedback.reward_confirmation")).resolves.toBe(true);
    expect(clients[0]?.queries[1]).toMatchObject({
      text: expect.stringContaining("SELECT EXISTS"),
      values: ["tester.feedback.reward_confirmation"],
    });
    expect(clients[0]?.queries[1]?.text).toContain("status IN ('pending', 'failed', 'processing')");
    expect(clients[0]?.queries[1]?.text).not.toContain("processed_at IS NULL");
  });

  it("confines the role-free lane to this concrete adapter", () => {
    const users = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean)
      .filter((file) => !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("createPostgresOutboxTransactionLane"))
      .sort();

    expect(users).toEqual([
      "server/adapters/postgres/dataGateway.ts",
      "server/adapters/postgres/outboxStore.ts",
    ]);
  });

  it("uses one role-free pooled transaction per authored rail operation", async () => {
    const { pool, clients } = stubPool();
    const store = createPostgresOutboxStore({ connectionString: "x" }, { poolFactory: () => pool });

    await expect(store.claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      knownEventTypes: ["commerce.order_draft.created"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).resolves.toEqual([eventRow()]);
    await expect(store.markProcessed({ eventId: "evt-1", claimToken: "token-1" }))
      .resolves.toEqual({ applied: true });
    await expect(store.markFailed({
      eventId: "evt-1",
      claimToken: "token-1",
      error: "provider down",
      outcome: "snooze",
      baseDelaySeconds: 60,
      maxDelaySeconds: 3600,
      maxAttempts: 8,
      snoozeSeconds: 300,
    })).resolves.toEqual({ status: "snoozed" });
    await expect(store.releaseUnprocessed([{ eventId: "evt-1", claimToken: "token-1" }], 300))
      .resolves.toBe(2);

    expect(clients).toHaveLength(4);
    for (const client of clients) {
      const texts = client.queries.map((query) => query.text);
      expect(texts[0]).toBe("BEGIN");
      expect(texts.at(-1)).toBe("COMMIT");
      expect(texts.join(" ")).not.toContain("SET LOCAL ROLE");
      expect(client.released).toBe(true);
    }
    expect(clients.map((client) => client.queries[1]?.text)).toEqual([
      expect.stringContaining('"outbox_claim_batch"'),
      expect.stringContaining('"outbox_mark_processed"'),
      expect.stringContaining('"outbox_mark_failed"'),
      expect.stringContaining('"outbox_release_unprocessed"'),
    ]);
  });

  it("rolls back and releases the operation transaction when a rail rpc fails", async () => {
    const { pool, clients } = stubPool({ failRpc: "outbox_claim_batch" });
    const store = createPostgresOutboxStore({ connectionString: "x" }, { poolFactory: () => pool });

    await expect(store.claimBatch({
      eventTypes: ["commerce.order_draft.created"],
      batchSize: 1,
      visibilitySeconds: 300,
      maxAttempts: 8,
    })).rejects.toMatchObject({ code: "P0001" });

    expect(clients[0]?.queries.map((query) => query.text)).toEqual([
      "BEGIN",
      expect.stringContaining('"outbox_claim_batch"'),
      "ROLLBACK",
    ]);
    expect(clients[0]?.released).toBe(true);
  });

  it("commits claim before worker handler IO and closes the scoped pool", async () => {
    const { pool, clients, wasEnded } = stubPool();
    const store = createPostgresOutboxStore({ connectionString: "x" }, { poolFactory: () => pool });
    let handlerSawCommittedClaim = false;

    const result = await runOutboxDispatchWorker({
      store,
      registry: new Map([["commerce.order_draft.created", {
        eventType: "commerce.order_draft.created",
        timeoutMs: 1000,
        handle: async () => {
          handlerSawCommittedClaim = clients[0]?.queries.some((query) => query.text === "COMMIT") ?? false;
          return { kind: "processed" as const };
        },
      }]]),
      config: {
        batchSize: 1, maxAttempts: 8, visibilitySeconds: 300, backoffBaseSeconds: 60,
        backoffCapSeconds: 3600, snoozeSeconds: 300, maxSnoozes: 48, softBudgetMs: 40_000,
      },
    });

    expect(result.processed).toBe(1);
    expect(handlerSawCommittedClaim).toBe(true);
    await store.close();
    expect(wasEnded()).toBe(true);
  });
});
