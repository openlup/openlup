import { TypeOverrides } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createPostgresDataGateway,
  createPostgresGatewayTypeOverrides,
  createPostgresTransactionalDeliveryTransactionLane,
  createPostgresCommunicationsControlPlaneTransactionLane,
  createPostgresPlatformControlPlaneTransactionLane,
  createPostgresCustomerDiagnosticHistoryTransactionLane,
  postgresTimestampTzToRfc3339,
  resolvePostgresDataGatewayEnv,
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

describe("createPostgresDataGateway", () => {
  it("preserves timestamptz microseconds for exact schedule round-trips", () => {
    const types = createPostgresGatewayTypeOverrides(TypeOverrides);
    const timestamp = "2030-01-10 00:00:00.123456+00";
    // @types/pg models the returned parser's input as the OID even though the
    // runtime parser receives the field text; narrow that known typing defect.
    const parser = types.getTypeParser(1184) as unknown as (value: string) => unknown;
    const parsed = parser(timestamp);
    expect(parsed).toBe("2030-01-10T00:00:00.123456+00:00");
    expect(z.string().datetime({ offset: true }).safeParse(parsed).success).toBe(true);
  });

  it("does not rewrite special or already-canonical timestamptz values", () => {
    expect(postgresTimestampTzToRfc3339("infinity")).toBe("infinity");
    expect(postgresTimestampTzToRfc3339("2030-01-10T00:00:00Z")).toBe("2030-01-10T00:00:00Z");
  });

  it("exposes asActor + asService", () => {
    const gw = createPostgresDataGateway({ connectionString: "" });
    expect(typeof gw.asActor).toBe("function");
    expect(typeof gw.asService).toBe("function");
  });

  it("asService runs work in a tx as service_role and commits", async () => {
    const { pool, client } = stubPool();
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    const result = await gw.asService(async () => "done");
    expect(result).toBe("done");
    const texts = client.queries.map((q) => q.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts).toContain("SET LOCAL ROLE service_role");
    expect(texts).toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("asActor sets request.jwt.claims (parameterized) + authenticated role for a real principal", async () => {
    const { pool, client } = stubPool();
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    await gw.asActor({ sub: "user-1", role: "authenticated" }, async () => null);
    const setConfig = client.queries.find((q) => q.text.includes("set_config"));
    expect(setConfig).toBeDefined();
    // Claims are bound as a param ($1), never interpolated.
    expect(setConfig?.text).toContain("$1");
    expect(setConfig?.values?.[0]).toBe('{"sub":"user-1","role":"authenticated"}');
    expect(client.queries.map((q) => q.text)).toContain("SET LOCAL ROLE authenticated");
  });

  it("asActor with null/empty claims drops to anon (RLS-bound, NOT the login superuser)", async () => {
    const { pool, client } = stubPool();
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    await gw.asActor(null, async () => null);
    // No claims set...
    expect(client.queries.find((q) => q.text.includes("set_config"))).toBeUndefined();
    expect(client.queries.map((q) => q.text)).not.toContain("SET LOCAL ROLE authenticated");
    // ...but it MUST switch to anon so a superuser login role can't bypass RLS for an anon actor.
    expect(client.queries.map((q) => q.text)).toContain("SET LOCAL ROLE anon");
    expect(client.queries[0].text).toBe("BEGIN");
    expect(client.queries.map((q) => q.text)).toContain("COMMIT");
  });

  it("asActor with empty-sub claims also drops to anon", async () => {
    const { pool, client } = stubPool();
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    await gw.asActor({ sub: "" }, async () => null);
    expect(client.queries.map((q) => q.text)).toContain("SET LOCAL ROLE anon");
    expect(client.queries.find((q) => q.text.includes("set_config"))).toBeUndefined();
  });

  it("rolls back and releases the client when work throws", async () => {
    const { pool, client } = stubPool();
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    await expect(
      gw.asService(async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(client.queries.map((q) => q.text)).toContain("ROLLBACK");
    expect(client.queries.map((q) => q.text)).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });

  it("does not run service work when mandatory role setup fails", async () => {
    const { pool, client } = stubPool({ failOn: "SET LOCAL ROLE service_role" });
    const gw = createPostgresDataGateway({ connectionString: "x" }, { poolFactory: () => pool });
    const work = vi.fn(async () => null);

    await expect(gw.asService(work)).rejects.toThrow("boom on SET LOCAL ROLE service_role");
    expect(work).not.toHaveBeenCalled();
    expect(client.queries.map((query) => query.text)).toContain("ROLLBACK");
    expect(client.queries.map((query) => query.text)).not.toContain("COMMIT");
    expect(client.released).toBe(true);
  });

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

  it("reuses a single pool across calls (factory invoked once)", async () => {
    let built = 0;
    const { pool } = stubPool();
    const gw = createPostgresDataGateway(
      { connectionString: "x" },
      {
        poolFactory: () => {
          built += 1;
          return pool;
        },
      },
    );
    await gw.asService(async () => null);
    await gw.asService(async () => null);
    expect(built).toBe(1);
  });

  it("resolvePostgresDataGatewayEnv reads DATABASE_URL", () => {
    expect(resolvePostgresDataGatewayEnv({ DATABASE_URL: "postgres://x" }).connectionString).toBe(
      "postgres://x",
    );
    expect(resolvePostgresDataGatewayEnv({}).connectionString).toBe("");
  });
});
