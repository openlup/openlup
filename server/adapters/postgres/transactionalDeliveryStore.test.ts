import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createPostgresTransactionalDeliveryStore } from "./transactionalDeliveryStore.js";

const row = {
  idempotency_key: "delivery:1", command_fingerprint: "a".repeat(64), state: "accepted",
  delivery_reference: "captured:delivery:1", error_code: null, attempt_count: 2,
};

function poolStub(fail = false) {
  const clients: Array<{ queries: string[]; released: boolean }> = [];
  let ended = false;
  return {
    clients,
    ended: () => ended,
    pool: {
      async connect() {
        const tracked = { queries: [] as string[], released: false };
        clients.push(tracked);
        return {
          async query(text: string) {
            tracked.queries.push(text);
            if (fail && text.includes("transactional_delivery_read_receipt")) throw Object.assign(new Error("rail down"), { code: "P0001" });
            if (text.includes("transactional_delivery_read_receipt")) return { rows: [] };
            return { rows: [row] };
          },
          release() { tracked.released = true; },
        };
      },
      async end() { ended = true; },
    } as never,
  };
}

describe("Postgres transactional delivery receipt store", () => {
  it("confines the receipt role-free lane to its concrete adapter across production TypeScript", () => {
    const users = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean)
      .filter((file) => !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("createPostgresTransactionalDeliveryTransactionLane"))
      .sort();
    expect(users).toEqual([
      "server/adapters/postgres/dataGateway.ts",
      "server/adapters/postgres/transactionalDeliveryStore.ts",
    ]);
  });

  it("uses a separate role-free transaction for read and both record operations", async () => {
    const { pool, clients, ended } = poolStub();
    const store = createPostgresTransactionalDeliveryStore({ connectionString: "x" }, { poolFactory: () => pool });

    await expect(store.readReceipt("delivery:1")).resolves.toBeNull();
    await expect(store.recordAccepted({ idempotencyKey: "delivery:1", commandFingerprint: "a".repeat(64), deliveryReference: "captured:delivery:1" }))
      .resolves.toMatchObject({ state: "accepted", attemptCount: 2 });
    await expect(store.recordFailed({ idempotencyKey: "delivery:1", commandFingerprint: "a".repeat(64), errorCode: "captured_delivery_failed" }))
      .resolves.toMatchObject({ state: "accepted" });
    expect(clients).toHaveLength(3);
    for (const client of clients) {
      expect(client.queries[0]).toBe("BEGIN");
      expect(client.queries.at(-1)).toBe("COMMIT");
      expect(client.queries.join(" ")).not.toContain("SET LOCAL ROLE");
      expect(client.released).toBe(true);
    }
    await store.close();
    expect(ended()).toBe(true);
  });

  it("rolls back and releases the exact operation when its receipt RPC fails", async () => {
    const { pool, clients } = poolStub(true);
    const store = createPostgresTransactionalDeliveryStore({ connectionString: "x" }, { poolFactory: () => pool });
    await expect(store.readReceipt("delivery:1")).rejects.toMatchObject({ code: "P0001" });
    expect(clients[0]).toMatchObject({ released: true, queries: ["BEGIN", expect.any(String), "ROLLBACK"] });
  });
});
