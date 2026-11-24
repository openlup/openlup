import { once } from "node:events";
import { createServer } from "node:http";
import { setImmediate } from "node:timers/promises";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { dockerAvailable } from "../helpers/postgresContainer.js";
import { leaseFromEndpoint, startPgTemplateBroker } from "../helpers/pgTemplateBroker.js";

const describeIfDocker = (await dockerAvailable()) ? describe : describe.skip;

it.each(["legacy", "qualified-admin", "qualified-v2"] as const)("uses one control POST per socket for %s", async profile => {
  const requests: { path: string | undefined; socket: number }[] = [];
  let socketId = 0;
  let responseMode: "ok" | "refuse" | "reset" = "ok";
  const sockets = new WeakMap<object, number>();
  const server = createServer((request, response) => {
    const socket = sockets.get(request.socket)!;
    const reused = requests.some(previous => previous.socket === socket);
    requests.push({ path: request.url, socket });
    if (reused || responseMode === "reset") {
      request.socket.resetAndDestroy();
      return;
    }
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.statusCode = responseMode === "refuse" ? 409 : 200;
    response.end(JSON.stringify(responseMode === "refuse" ? { error: "fixture_refused" } : { id: "lease" }));
  });
  server.on("connection", socket => sockets.set(socket, ++socketId));
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing broker listener address");
    const endpoint = { url: `http://127.0.0.1:${address.port}`, token: "fixture" };
    const lease = await leaseFromEndpoint(endpoint, profile);
    expect(lease.id).toBe("lease");
    // Let an eligible keep-alive socket return to the client's idle pool.
    await setImmediate();
    await expect(lease.release()).resolves.toBeUndefined();
    responseMode = "refuse";
    await expect(leaseFromEndpoint(endpoint, profile)).rejects.toThrow("pg_template_broker_clone_failed (409): fixture_refused");
    responseMode = "ok";
    const refusedRelease = await leaseFromEndpoint(endpoint, profile);
    responseMode = "refuse";
    await expect(refusedRelease.release()).rejects.toThrow("pg_template_broker_release_failed (409): fixture_refused");
    responseMode = "ok";
    const resetRelease = await leaseFromEndpoint(endpoint, profile);
    responseMode = "reset";
    await expect(resetRelease.release()).rejects.toMatchObject({ cause: { code: "ECONNRESET" } });
    expect(requests.map(request => request.path)).toEqual(["/clone", "/release", "/clone", "/clone", "/release", "/clone", "/release"]);
    expect(new Set(requests.map(request => request.socket)).size).toBe(requests.length);
  } finally {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }
});

describe("PostgreSQL template broker (lazy boot & auth boundary)", () => {
  it("starts zero containers on boot and refuses unauthenticated requests with 401", async () => {
    const broker = await startPgTemplateBroker();
    try {
      expect(broker.activeClusterCount()).toBe(0);

      const noAuth = await fetch(`${broker.url}/clone`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: "legacy" }),
      });
      expect(noAuth.status).toBe(401);

      const wrongAuth = await fetch(`${broker.url}/clone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ profile: "legacy" }),
      });
      expect(wrongAuth.status).toBe(401);
      expect(broker.activeClusterCount()).toBe(0);
    } finally {
      await broker.close();
    }
  });
});

describeIfDocker("PostgreSQL template broker (cloning, isolation, ownership & drift guard)", () => {
  it(
    "clones isolated databases with rotated installation_key, preserves qualified-admin ownership, drops on release, and rejects cluster-role mutations",
    async () => {
      const broker = await startPgTemplateBroker();
      try {
        expect(broker.activeClusterCount()).toBe(0);

        // 1. Legacy profile: two concurrent clones share one cluster, get distinct DBs & installation keys.
        const [legacyA, legacyB] = await Promise.all([
          leaseFromEndpoint(broker, "legacy", "cloneA"),
          leaseFromEndpoint(broker, "legacy", "cloneB"),
        ]);
        expect(broker.activeClusterCount()).toBe(1);
        expect(legacyA.dbName).not.toBe(legacyB.dbName);

        const poolA = new Pool({ connectionString: legacyA.ownerUrl });
        const poolB = new Pool({ connectionString: legacyB.ownerUrl });
        try {
          const [keyA, keyB] = await Promise.all([
            poolA.query<{ key_hex: string }>("SELECT encode(key_bytes, 'hex') AS key_hex FROM acquisition_private.installation_key WHERE singleton"),
            poolB.query<{ key_hex: string }>("SELECT encode(key_bytes, 'hex') AS key_hex FROM acquisition_private.installation_key WHERE singleton"),
          ]);
          expect(keyA.rows[0]?.key_hex).toHaveLength(64);
          expect(keyB.rows[0]?.key_hex).toHaveLength(64);
          expect(keyA.rows[0]?.key_hex).not.toBe(keyB.rows[0]?.key_hex);
        } finally {
          await Promise.all([poolA.end(), poolB.end()]);
        }

        await legacyA.release();

        // Confirm dropped DB no longer exists in pg_database (observed from legacyB).
        const verifyDrop = new Pool({ connectionString: legacyB.ownerUrl });
        try {
          const remaining = await verifyDrop.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_database WHERE datname = $1",
            [legacyA.dbName],
          );
          expect(remaining.rows[0]?.count).toBe("0");

          // Mutate a cluster-global role on legacyB to verify the fail-loud drift guard.
          await verifyDrop.query("CREATE ROLE broker_drift_witness NOLOGIN");
        } finally {
          await verifyDrop.end();
        }
        await expect(legacyB.release()).rejects.toThrow(/cluster_role_mutation_detected/);

        // 2. Qualified-admin profile: clone DB is owned by lifecycle_m and rotates installation_key cleanly.
        const adminLease = await leaseFromEndpoint(broker, "qualified-admin", "adminClone");
        expect(broker.activeClusterCount()).toBe(2);
        const adminPool = new Pool({ connectionString: adminLease.migrationUrl });
        try {
          const ownerRow = await adminPool.query<{ owner: string }>(
            "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
          );
          expect(ownerRow.rows[0]?.owner).toBe("lifecycle_m");
        } finally {
          await adminPool.end();
        }
        await adminLease.release();

        // 3. Releasing immediately after Pool.end() (with zero extra sleep) drains backends cleanly without 57P01.
        const drainLease = await leaseFromEndpoint(broker, "qualified-admin", "drainCheck");
        const drainPool = new Pool({ connectionString: drainLease.runtimeUrl });
        const poolErrors: unknown[] = [];
        drainPool.on("error", (err) => { poolErrors.push(err); });
        await drainPool.query("SELECT 1");
        await drainPool.end();
        await drainLease.release();
        expect(poolErrors).toEqual([]);
      } finally {
        await broker.close();
      }
      expect(broker.activeClusterCount()).toBe(0);
    },
    180_000,
  );
});
