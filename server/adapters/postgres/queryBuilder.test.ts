import { describe, expect, it } from "vitest";

import { PgGatewayClient, PgQueryBuilder, type PgQueryExecutor } from "./queryBuilder.js";

/** Capturing executor: records every (text, values) pair and returns canned rows. */
function fakeExecutor(rows: Record<string, unknown>[] = []): PgQueryExecutor & {
  calls: Array<{ text: string; values: unknown[] }>;
} {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  return {
    calls,
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows };
    },
  };
}

describe("PgQueryBuilder — injection safety", () => {
  it("never interpolates filter values; they always become $N params", async () => {
    const exec = fakeExecutor();
    const malicious = "x'; DROP TABLE clients; --";
    await new PgQueryBuilder(exec, "clients").select("id").eq("id", malicious);
    const { text, values } = exec.calls[0];
    // The raw value must NOT appear in the SQL text — only a placeholder.
    expect(text).not.toContain("DROP TABLE");
    expect(text).toContain("$1");
    expect(values).toEqual([malicious]);
  });

  it("rejects an unsafe table identifier instead of interpolating it", async () => {
    const exec = fakeExecutor();
    const result = await new PgQueryBuilder(exec, "clients; DROP TABLE x").select("*");
    // compile() throws → run() returns it as a shim error (no query issued).
    expect(result.error).not.toBeNull();
    expect(result.error?.message).toMatch(/unsafe identifier/);
    expect(exec.calls.length).toBe(0);
  });

  it("rejects an unsafe column identifier in a filter", async () => {
    const exec = fakeExecutor();
    const result = await new PgQueryBuilder(exec, "clients").select("*").eq("id); DROP", 1);
    expect(result.error?.message).toMatch(/unsafe identifier/);
  });
});

describe("PgQueryBuilder — SQL generation per method", () => {
  it("select + eq + order + limit renders parameterized SQL", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "commerce_orders")
      .select("id, status, created_at")
      .eq("client_id", "c1")
      .order("created_at", { ascending: false })
      .limit(5);
    const { text, values } = exec.calls[0];
    expect(text).toBe(
      'SELECT "id", "status", "created_at" FROM "commerce_orders" WHERE "client_id" = $1 ORDER BY "created_at" DESC LIMIT $2',
    );
    expect(values).toEqual(["c1", 5]);
  });

  it("in() with values renders an IN list of params", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "clients").select("*").in("id", ["a", "b", "c"]);
    const { text, values } = exec.calls[0];
    expect(text).toContain('"id" IN ($1, $2, $3)');
    expect(values).toEqual(["a", "b", "c"]);
  });

  it("in() with an empty array matches nothing (false), no params", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "clients").select("*").in("id", []);
    expect(exec.calls[0].text).toContain("WHERE false");
    expect(exec.calls[0].values).toEqual([]);
  });

  it("gte/lte/gt comparisons render parameterized", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "t").select("*").gte("a", 1).lte("b", 2).gt("c", 3);
    const { text, values } = exec.calls[0];
    expect(text).toContain('"a" >= $1');
    expect(text).toContain('"b" <= $2');
    expect(text).toContain('"c" > $3');
    expect(values).toEqual([1, 2, 3]);
  });

  it("ilike renders ILIKE with a param", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "t").select("*").ilike("name", "%foo%");
    expect(exec.calls[0].text).toContain('"name" ILIKE $1');
    expect(exec.calls[0].values).toEqual(["%foo%"]);
  });

  it("is(null/true/false) renders IS keyword without params", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "t").select("*").is("active", true);
    expect(exec.calls[0].text).toContain('"active" IS TRUE');
    expect(exec.calls[0].values).toEqual([]);
    const exec2 = fakeExecutor();
    await new PgQueryBuilder(exec2, "t").select("*").is("deleted_at", null);
    expect(exec2.calls[0].text).toContain('"deleted_at" IS NULL');
  });

  it("insert renders parameterized VALUES with RETURNING", async () => {
    const exec = fakeExecutor([{ id: "op1" }]);
    const result = await new PgQueryBuilder(exec, "commerce_order_operations")
      .insert({ order_id: "o1", note: "hi" })
      .select("id, order_id")
      .maybeSingle();
    const { text, values } = exec.calls[0];
    expect(text).toBe(
      'INSERT INTO "commerce_order_operations" ("order_id", "note") VALUES ($1, $2) RETURNING "id", "order_id"',
    );
    expect(values).toEqual(["o1", "hi"]);
    expect(result.data).toEqual({ id: "op1" });
  });

  it("update renders SET assignments + WHERE, all parameterized", async () => {
    const exec = fakeExecutor();
    await new PgQueryBuilder(exec, "t").update({ status: "paid" }).eq("id", "x");
    const { text, values } = exec.calls[0];
    expect(text).toBe('UPDATE "t" SET "status" = $1 WHERE "id" = $2');
    expect(values).toEqual(["paid", "x"]);
  });

  it("range(from,to) maps to LIMIT/OFFSET (inclusive)", async () => {
    const exec = fakeExecutor([{ id: 1 }, { id: 2 }]);
    const result = await new PgQueryBuilder(exec, "t").select("*").range(10, 19);
    const { text, values } = exec.calls[0];
    expect(text).toContain("LIMIT $1");
    expect(text).toContain("OFFSET $2");
    expect(values).toEqual([10, 10]); // limit = 19-10+1 = 10, offset = 10
    expect(Array.isArray(result.data)).toBe(true);
  });
});

describe("PgQueryBuilder — result cardinality semantics", () => {
  it("default await returns the row array under data", async () => {
    const exec = fakeExecutor([{ id: 1 }, { id: 2 }]);
    const result = await new PgQueryBuilder(exec, "t").select("*");
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.error).toBeNull();
  });

  it("maybeSingle returns one row, or null on zero rows", async () => {
    const one = await new PgQueryBuilder(fakeExecutor([{ id: 1 }]), "t").select("*").maybeSingle();
    expect(one.data).toEqual({ id: 1 });
    const none = await new PgQueryBuilder(fakeExecutor([]), "t").select("*").maybeSingle();
    expect(none.data).toBeNull();
    expect(none.error).toBeNull();
  });

  it("maybeSingle errors (PGRST116) when more than one row matches", async () => {
    const result = await new PgQueryBuilder(fakeExecutor([{ id: 1 }, { id: 2 }]), "t")
      .select("*")
      .maybeSingle();
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("PGRST116");
  });

  it("single errors when zero rows", async () => {
    const result = await new PgQueryBuilder(fakeExecutor([]), "t").select("*").single();
    expect(result.error?.code).toBe("PGRST116");
  });

  it("surfaces pg error code (e.g. 23505 unique violation) on data.error", async () => {
    const failing: PgQueryExecutor = {
      async query() {
        throw Object.assign(new Error("dupe"), { code: "23505" });
      },
    };
    const result = await new PgQueryBuilder(failing, "t").insert({ a: 1 }).select("a").maybeSingle();
    expect(result.error?.code).toBe("23505");
    expect(result.error?.message).toBe("dupe");
  });
});

describe("PgQueryBuilder — PostgREST count/head semantics", () => {
  /** Executor whose Nth query resolves to the Nth canned row set (count first, rows second). */
  function scriptedExecutor(responses: Record<string, unknown>[][]): PgQueryExecutor & {
    calls: Array<{ text: string; values: unknown[] }>;
  } {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    return {
      calls,
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        return { rows: responses[calls.length - 1] ?? [] };
      },
    };
  }

  it("count:exact aggregates over the same WHERE and ignores limit/offset, like PostgREST", async () => {
    // pg returns count(*) as a bigint string; the shim must hand back a number.
    const exec = scriptedExecutor([[{ exact_count: "42" }], [{ id: 1 }, { id: 2 }]]);
    const result = await new PgQueryBuilder(exec, "catalog_skus")
      .select("id", { count: "exact" })
      .eq("status", "active")
      .limit(2);
    expect(exec.calls).toHaveLength(2);
    expect(exec.calls[0].text).toBe('SELECT count(*) AS exact_count FROM "catalog_skus" WHERE "status" = $1');
    expect(exec.calls[0].values).toEqual(["active"]);
    expect(exec.calls[0].text).not.toContain("LIMIT");
    expect(exec.calls[1].text).toContain("LIMIT $2");
    expect(result.count).toBe(42);
    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.error).toBeNull();
  });

  it("head:true returns the count with data null and issues no row query at all", async () => {
    const exec = scriptedExecutor([[{ exact_count: "7" }]]);
    const result = await new PgQueryBuilder(exec, "price_entries").select("id", { count: "exact", head: true });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].text).toBe('SELECT count(*) AS exact_count FROM "price_entries"');
    expect(result).toEqual({ data: null, error: null, count: 7 });
  });

  it("reports 0 for an empty match instead of leaving the count unknown", async () => {
    const exec = scriptedExecutor([[{ exact_count: "0" }]]);
    const result = await new PgQueryBuilder(exec, "clients").select("id", { count: "exact", head: true }).in("id", []);
    expect(exec.calls[0].text).toBe('SELECT count(*) AS exact_count FROM "clients" WHERE false');
    expect(result.count).toBe(0);
  });

  it("a plain select reports count null, matching the client contract when none was requested", async () => {
    const exec = fakeExecutor([{ id: 1 }, { id: 2 }]);
    const result = await new PgQueryBuilder(exec, "clients").select("*");
    expect(exec.calls).toHaveLength(1);
    expect(result.count).toBeNull();
  });

  it("carries the count through maybeSingle and reports count null when the query fails", async () => {
    const single = scriptedExecutor([[{ exact_count: "1" }], [{ id: "c1" }]]);
    const found = await new PgQueryBuilder(single, "clients")
      .select("id", { count: "exact" })
      .eq("id", "c1")
      .maybeSingle();
    expect(found.data).toEqual({ id: "c1" });
    expect(found.count).toBe(1);

    const failing: PgQueryExecutor = {
      async query() {
        throw Object.assign(new Error("relation missing"), { code: "42P01" });
      },
    };
    const failed = await new PgQueryBuilder(failing, "missing_table").select("id", { count: "exact", head: true });
    expect(failed.error?.code).toBe("42P01");
    expect(failed.count).toBeNull();
  });
});

describe("PgGatewayClient — rpc", () => {
  it("passes named-adapter SQL and values to the transaction executor unchanged", async () => {
    const exec = fakeExecutor([{ id: "catalog-1" }]);
    const result = await new PgGatewayClient(exec).query(
      "SELECT id WHERE key = $1",
      ["reference-alpha"],
    );
    expect(exec.calls).toEqual([{
      text: "SELECT id WHERE key = $1",
      values: ["reference-alpha"],
    }]);
    expect(result.rows).toEqual([{ id: "catalog-1" }]);
  });

  it("calls rpc with NAMED args, all parameterized", async () => {
    const exec = fakeExecutor([{ ok: true }]);
    await new PgGatewayClient(exec).rpc("commerce_oms_create_hold", {
      p_order_id: "o1",
      p_reason: "fraud",
    });
    const { text, values } = exec.calls[0];
    expect(text).toBe('SELECT * FROM "commerce_oms_create_hold"("p_order_id" => $1, "p_reason" => $2)');
    expect(values).toEqual(["o1", "fraud"]);
  });

  it("unwraps a scalar set-returning function result", async () => {
    // 1 row × 1 column named after the function → the scalar value.
    const exec = fakeExecutor([{ commerce_configurator_persist_intent: { id: "x" } }]);
    const result = await new PgGatewayClient(exec).rpc("commerce_configurator_persist_intent", {
      p_intent: { foo: 1 },
    });
    expect(result.data).toEqual({ id: "x" });
  });

  it("returns the row array for a TABLE-returning function", async () => {
    const exec = fakeExecutor([{ a: 1 }, { a: 2 }]);
    const result = await new PgGatewayClient(exec).rpc("commerce_oms_admin_list_queue", { p_page: 1 });
    expect(result.data).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("rejects an unsafe rpc function name", async () => {
    const exec = fakeExecutor();
    const result = await new PgGatewayClient(exec).rpc("foo(); DROP", {});
    expect(result.error?.message).toMatch(/unsafe identifier/);
    expect(exec.calls.length).toBe(0);
  });

  it("from() returns a builder bound to the table", () => {
    const exec = fakeExecutor();
    const builder = new PgGatewayClient(exec).from("clients");
    expect(builder).toBeInstanceOf(PgQueryBuilder);
  });
});

// F3/F4 — the two live-found divergences from PostgREST, measured against 14.10 before the repair.
describe("PgQueryBuilder — PostgREST refusals the shim used to answer around", () => {
  /** Executor whose Nth query resolves to the Nth canned row set (count first, rows second). */
  function scripted(sets: Record<string, unknown>[][]): PgQueryExecutor & { calls: number } {
    let index = 0;
    const state = {
      calls: 0,
      async query() {
        state.calls += 1;
        return { rows: sets[index++] ?? [] };
      },
    };
    return state;
  }

  it("refuses a page past the end with PGRST103 once the total is known", async () => {
    const exec = scripted([[{ exact_count: "2" }]]);
    const result = await new PgQueryBuilder(exec, "catalog_skus").select("id", { count: "exact" }).range(6, 9);
    expect(result.error).toEqual({
      code: "PGRST103",
      message: "Requested range not satisfiable",
      details: "An offset of 6 was requested, but there are only 2 rows.",
    });
    expect(result.data).toEqual([]);
    expect(result.count).toBeNull();
    // The row query is never issued: the refusal replaces the page, it does not annotate it.
    expect(exec.calls).toBe(1);
  });

  it("treats offset === total as a legal empty page, exactly where PostgREST does", async () => {
    const exec = scripted([[{ exact_count: "2" }], []]);
    const result = await new PgQueryBuilder(exec, "catalog_skus").select("id", { count: "exact" }).range(2, 9);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
    expect(result.count).toBe(2);
  });

  it("still answers an empty page when no exact count was requested", async () => {
    const exec = scripted([[]]);
    const result = await new PgQueryBuilder(exec, "catalog_skus").select("id").range(900, 909);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("refuses a heterogeneous insert batch with PGRST102 instead of dropping a column", async () => {
    const exec = fakeExecutor();
    const result = await new PgQueryBuilder(exec, "commerce_settings")
      .insert([{ key: "a", value_minor: 1 }, { key: "b", value_minor: 2, value_text: "compact" }])
      .select("key");
    expect(result.error?.code).toBe("PGRST102");
    expect(result.error?.message).toBe("All object keys must match");
    expect(exec.calls.length).toBe(0);
  });

  it("refuses the mirror case too: a later row missing a column the first row carried", async () => {
    const exec = fakeExecutor();
    const result = await new PgQueryBuilder(exec, "commerce_settings")
      .insert([{ key: "a", value_text: "compact" }, { key: "b" }])
      .select("key");
    expect(result.error?.code).toBe("PGRST102");
    expect(exec.calls.length).toBe(0);
  });

  it("still accepts a homogeneous batch whose keys are merely in a different order", async () => {
    const exec = fakeExecutor([{ key: "a" }]);
    const result = await new PgQueryBuilder(exec, "commerce_settings")
      .insert([{ key: "a", value_minor: 1 }, { value_minor: 2, key: "b" }])
      .select("key");
    expect(result.error).toBeNull();
    // Column order follows the FIRST row, and every later row is bound through that order.
    expect(exec.calls[0].text).toBe(
      'INSERT INTO "commerce_settings" ("key", "value_minor") VALUES ($1, $2), ($3, $4) RETURNING "key"',
    );
    expect(exec.calls[0].values).toEqual(["a", 1, "b", 2]);
  });
});
