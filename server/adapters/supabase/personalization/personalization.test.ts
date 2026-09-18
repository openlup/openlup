import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { createSupabasePersonalizationPort } from "./personalization.js";

// Minimal chainable fake of the supabase-js query builder: select/eq/order/limit
// return `this`; maybeSingle() resolves the per-table canned result; upsert()
// records the row and resolves { error }.
function fakeClient(opts: {
  tables?: Record<string, { data: unknown; error?: unknown }>;
  rpc?: { error?: unknown };
}): {
  client: SupabaseClient;
  upserts: Array<{ table: string; row: Record<string, unknown>; options: unknown }>;
  rpcCalls: Array<{ name: string; args: unknown }>;
} {
  const upserts: Array<{ table: string; row: Record<string, unknown>; options: unknown }> = [];
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const client = {
    from(table: string) {
      const result = opts.tables?.[table] ?? { data: null, error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve(result),
        upsert: (row: Record<string, unknown>, options: unknown) => {
          upserts.push({ table, row, options });
          return Promise.resolve({ error: opts.tables?.[table]?.error ?? null });
        },
      };
      return builder;
    },
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ error: opts.rpc?.error ?? null });
    },
  } as unknown as SupabaseClient;
  return { client, upserts, rpcCalls };
}

describe("supabase personalization port", () => {
  it("loadNames maps client first name + most-recent dog pet", async () => {
    const { client } = fakeClient({
      tables: {
        clients: { data: { first_name: "Anna" } },
        pets: { data: { id: "pet-9", name: "Reksio" } },
      },
    });
    const names = await createSupabasePersonalizationPort(client).loadNames("c1");
    expect(names).toEqual({
      clientId: "c1",
      ownerName: "Anna",
      dogName: "Reksio",
      primaryPetId: "pet-9",
    });
  });

  it("loadNames returns null when the client row is absent", async () => {
    const { client } = fakeClient({ tables: { clients: { data: null } } });
    expect(await createSupabasePersonalizationPort(client).loadNames("gone")).toBeNull();
  });

  it("writePersonalization upserts snake_case row on client_id conflict", async () => {
    const { client, upserts } = fakeClient({});
    await createSupabasePersonalizationPort(client).writePersonalization({
      clientId: "c1",
      ownerNameRaw: "Anna",
      ownerCases: { nominative: "Anna" } as never,
      ownerConf: "high",
      primaryPetId: "pet-9",
      dogNameRaw: "Reksio",
      dogCases: { genitive: "Reksia" } as never,
      dogGender: "masculine",
      dogConf: "high",
      source: "dictionary",
      modelVersion: "dict-v1",
      inputHash: "abc",
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].table).toBe("customer_personalization");
    expect(upserts[0].options).toEqual({ onConflict: "client_id" });
    expect(upserts[0].row).toMatchObject({
      client_id: "c1",
      owner_conf: "high",
      dog_gender: "masculine",
      source: "dictionary",
      input_hash: "abc",
    });
  });

  it("readInputHash returns the stored hash or null", async () => {
    const hit = fakeClient({ tables: { customer_personalization: { data: { input_hash: "h1" } } } });
    expect(await createSupabasePersonalizationPort(hit.client).readInputHash("c1")).toBe("h1");
    const miss = fakeClient({ tables: { customer_personalization: { data: null } } });
    expect(await createSupabasePersonalizationPort(miss.client).readInputHash("c1")).toBeNull();
  });

  it("enqueueDeclension calls the SQL enqueue RPC", async () => {
    const { client, rpcCalls } = fakeClient({});
    await createSupabasePersonalizationPort(client).enqueueDeclension({
      clientId: "c1",
      inputHash: "abc",
    });
    expect(rpcCalls).toEqual([
      { name: "personalization_enqueue_declension", args: { p_client_id: "c1", p_input_hash: "abc" } },
    ]);
  });

  it("throws when the enqueue RPC errors", async () => {
    const { client } = fakeClient({ rpc: { error: { message: "boom" } } });
    await expect(
      createSupabasePersonalizationPort(client).enqueueDeclension({ clientId: "c1", inputHash: "abc" }),
    ).rejects.toBeTruthy();
  });
});
