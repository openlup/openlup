import { describe, expect, it, vi } from "vitest";

import {
  bindBundleDataPort,
  bindDataPort,
  bindRequestActorDataPort,
} from "./dataBinding.js";

const hostedActorEnvironment = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "svc",
};

describe("bindDataPort", () => {
  it("binds a supabase gateway for the supabase capability (even with empty env)", () => {
    const port = bindDataPort("supabase", {});
    expect(port).not.toBeNull();
    expect(typeof port?.asActor).toBe("function");
    expect(typeof port?.asService).toBe("function");
  });

  it("binds a supabase gateway when env is fully populated", () => {
    const port = bindDataPort("supabase", hostedActorEnvironment);
    expect(port).not.toBeNull();
  });

  it("binds a direct-PG gateway for the postgres capability (W10, even with empty env)", () => {
    // Pure factory: the slot binds with no DATABASE_URL (no pool until asActor/asService runs work).
    const port = bindDataPort("postgres", {});
    expect(port).not.toBeNull();
    expect(typeof port?.asActor).toBe("function");
    expect(typeof port?.asService).toBe("function");
  });

  it("resolves the node-postgres bundle through the leaf data binding", () => {
    const env = {
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://example",
    };
    const port = bindBundleDataPort(env);
    const sameConfigPort = bindBundleDataPort({ ...env });
    const changedConfigPort = bindBundleDataPort({
      ...env,
      DATABASE_URL: "postgres://changed",
    });
    expect(port).not.toBeNull();
    expect(typeof port?.asActor).toBe("function");
    expect(sameConfigPort).toBe(port);
    expect(changedConfigPort).not.toBe(port);
  });

  it("returns null for an unknown capability", () => {
    expect(bindDataPort("mystery", {})).toBeNull();
  });

  it("creates isolated actor-only request facades without bearer bleed", async () => {
    const createdOptions: unknown[] = [];
    const createClientImpl = (
      _url: string,
      _key: string,
      options: unknown,
    ) => {
      createdOptions.push(options);
      return { requestNumber: createdOptions.length };
    };
    const first = bindRequestActorDataPort("bearer-a", hostedActorEnvironment, {
      createClientImpl,
    });
    const second = bindRequestActorDataPort("bearer-b", hostedActorEnvironment, {
      createClientImpl,
    });

    expect(first).not.toBe(second);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect("asService" in first!).toBe(false);
    expect("asService" in second!).toBe(false);
    type ActorOnlyTypeProof =
      "asService" extends keyof NonNullable<typeof first> ? never : true;
    const actorOnlyTypeProof: ActorOnlyTypeProof = true;
    expect(actorOnlyTypeProof).toBe(true);

    await first?.asActor(
      { sub: "actor-a", role: "authenticated" },
      async () => undefined,
    );
    await second?.asActor(
      { sub: "actor-b", role: "authenticated" },
      async () => undefined,
    );

    expect(createdOptions).toEqual([
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer bearer-a" } },
      }),
      expect.objectContaining({
        global: { headers: { Authorization: "Bearer bearer-b" } },
      }),
    ]);
  });

  it("reuses one cached direct pool across fresh actor facades and isolated transactions", async () => {
    const clients: Array<{
      queries: Array<{ text: string; values?: unknown[] }>;
      released: boolean;
    }> = [];
    let poolBuilds = 0;
    const pool = {
      connect: vi.fn(async () => {
        const record = {
          queries: [] as Array<{ text: string; values?: unknown[] }>,
          released: false,
        };
        clients.push(record);
        return {
          query: vi.fn(async (text: string, values?: unknown[]) => {
            record.queries.push({ text, values });
            return { rows: [] };
          }),
          release: vi.fn(() => {
            record.released = true;
          }),
        };
      }),
    };

    vi.resetModules();
    vi.doMock("../adapters/postgres/dataGateway.js", async (importOriginal) => {
      const actual = await importOriginal<
        typeof import("../adapters/postgres/dataGateway.js")
      >();
      return {
        ...actual,
        createPostgresDataGateway: (environment: {
          connectionString: string;
        }) => actual.createPostgresDataGateway(environment, {
          poolFactory: () => {
            poolBuilds += 1;
            return pool as never;
          },
        }),
      };
    });

    try {
      const binding = await import("./dataBinding.js");
      const environment = {
        PLATFORM_BUNDLE: "node-postgres",
        DATABASE_URL: "postgres://fixture",
      };
      const first = binding.bindRequestActorDataPort("unused-a", environment);
      const second = binding.bindRequestActorDataPort("unused-b", environment);

      expect(first).not.toBe(second);
      expect("asService" in first!).toBe(false);
      expect("asService" in second!).toBe(false);
      await first?.asActor(
        { sub: "actor-a", role: "authenticated" },
        async () => undefined,
      );
      await expect(second?.asActor(
        { sub: "actor-b", role: "authenticated" },
        async () => {
          throw new Error("work failed");
        },
      )).rejects.toThrow("work failed");

      expect(poolBuilds).toBe(1);
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(clients).toHaveLength(2);
      expect(clients[0].queries.find((query) =>
        query.text.includes("set_config"))?.values?.[0]).toBe(
        '{"sub":"actor-a","role":"authenticated"}',
      );
      expect(clients[1].queries.find((query) =>
        query.text.includes("set_config"))?.values?.[0]).toBe(
        '{"sub":"actor-b","role":"authenticated"}',
      );
      for (const client of clients) {
        expect(client.queries.map((query) => query.text)).toContain(
          "SET LOCAL ROLE authenticated",
        );
        expect(client.queries.map((query) => query.text)).not.toContain(
          "SET LOCAL ROLE service_role",
        );
        expect(client.released).toBe(true);
      }
      expect(clients[0].queries.map((query) => query.text)).toContain("COMMIT");
      expect(clients[1].queries.map((query) => query.text)).toContain("ROLLBACK");
      expect(clients[1].queries.map((query) => query.text)).not.toContain("COMMIT");
    } finally {
      vi.doUnmock("../adapters/postgres/dataGateway.js");
      vi.resetModules();
    }
  });
});
