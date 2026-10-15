import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createPostgresTransactionalDeliveryTransactionLane,
  createPostgresCommunicationsControlPlaneTransactionLane,
  createPostgresPlatformControlPlaneTransactionLane,
  createPostgresCustomerDiagnosticHistoryTransactionLane,
} from "./dataGateway.js";

interface RecordedClient {
  queries: Array<{ text: string; values?: unknown[] }>;
  released: boolean;
}

/** Stub pool that records every query on its single client and whether it was released. */
function stubPool(opts: { failOn?: string } = {}) {
  const client: RecordedClient = { queries: [], released: false };
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          client.queries.push({ text, values });
          if (opts.failOn && text.includes(opts.failOn)) {
            throw new Error(`boom on ${opts.failOn}`);
          }
          return { rows: [] };
        },
        release() {
          client.released = true;
        },
      };
    },
  };
  return { pool: pool as never, client };
}

describe("reference named role-free lanes", () => {
  it("keeps the receipt lane role-free without weakening generic asService", async () => {
    const { pool, client } = stubPool();
    const lane = createPostgresTransactionalDeliveryTransactionLane(
      { connectionString: "x" },
      { poolFactory: () => pool },
    );

    await expect(lane.run(async () => "receipt")).resolves.toBe("receipt");
    expect(client.queries.map((query) => query.text)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("keeps the communications control plane on a role-free transaction", async () => {
    const { pool, client } = stubPool();
    const lane = createPostgresCommunicationsControlPlaneTransactionLane(
      { connectionString: "postgres://local" },
      { poolFactory: () => pool },
    );

    await expect(lane.run(async () => "communications")).resolves.toBe("communications");
    expect(client.queries.map((query) => query.text)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("keeps the platform control plane on its named role-free transaction", async () => {
    const { pool, client } = stubPool();
    const lane = createPostgresPlatformControlPlaneTransactionLane(
      { connectionString: "postgres://local" }, { poolFactory: () => pool },
    );
    await expect(lane.run(async () => "platform")).resolves.toBe("platform");
    expect(client.queries.map((query) => query.text)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("keeps diagnostic append and audited reads on their named role-free transaction", async () => {
    const { pool, client } = stubPool();
    const lane = createPostgresCustomerDiagnosticHistoryTransactionLane(
      { connectionString: "postgres://local" }, { poolFactory: () => pool },
    );
    await expect(lane.run(async () => "diagnostics")).resolves.toBe("diagnostics");
    expect(client.queries.map((query) => query.text)).toEqual(["BEGIN", "COMMIT"]);
    expect(client.released).toBe(true);
  });

});

describe("generic role-free lane confinement", () => {
  it("leaves the package's generic role-free lane to this binding alone", () => {
    const users = execFileSync("git", ["ls-files", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], { encoding: "utf8" })
      .split(/\r?\n/).filter(Boolean)
      .filter((file) => !file.startsWith("packages/platform/"))
      .filter((file) => !/\.(test|spec)\.(ts|tsx|mts|cts)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("createPostgresRoleFreeTransactionLane"))
      .sort();
    expect(users).toEqual(["server/adapters/postgres/dataGateway.ts"]);
  });
});
