import { describe, expect, it } from "vitest";

import {
  ParamAccumulator,
  joinParts,
  quoteIdent,
  renderColumns,
  rangeNotSatisfiable,
  renderFilter,
  renderInsertStatement,
  toShimError,
  type Filter,
} from "./queryBuilderSql.js";

describe("queryBuilderSql primitives", () => {
  describe("quoteIdent", () => {
    it("double-quotes a valid identifier", () => {
      expect(quoteIdent("orders")).toBe('"orders"');
      expect(quoteIdent("created_at")).toBe('"created_at"');
    });

    it("rejects anything that could smuggle SQL (the injection guard)", () => {
      expect(() => quoteIdent("orders; drop table x")).toThrow(/unsafe identifier/);
      expect(() => quoteIdent('a" or "1"="1')).toThrow(/unsafe identifier/);
      expect(() => quoteIdent("(select 1)")).toThrow(/unsafe identifier/);
      expect(() => quoteIdent("")).toThrow(/unsafe identifier/);
    });
  });

  describe("renderColumns", () => {
    it("passes through * and empty as *", () => {
      expect(renderColumns("*")).toBe("*");
      expect(renderColumns("")).toBe("*");
    });

    it("validates + quotes each column in a comma list", () => {
      expect(renderColumns("id, created_at")).toBe('"id", "created_at"');
    });

    it("rejects an injected column", () => {
      expect(() => renderColumns("id, x); drop table y")).toThrow(/unsafe identifier/);
    });
  });

  describe("ParamAccumulator", () => {
    it("hands back sequential $N placeholders and collects values in order", () => {
      const p = new ParamAccumulator();
      expect(p.add("a")).toBe("$1");
      expect(p.add(2)).toBe("$2");
      expect(p.add(null)).toBe("$3");
      expect(p.values).toEqual(["a", 2, null]);
    });
  });

  describe("renderFilter", () => {
    it("parameterizes scalar comparisons (never interpolates the value)", () => {
      const p = new ParamAccumulator();
      expect(renderFilter({ kind: "eq", column: "status", value: "paid" }, p)).toBe('"status" = $1');
      expect(renderFilter({ kind: "gte", column: "n", value: 5 }, p)).toBe('"n" >= $2');
      expect(p.values).toEqual(["paid", 5]);
    });

    it("renders IN with one placeholder per value; empty IN matches nothing", () => {
      const p = new ParamAccumulator();
      expect(renderFilter({ kind: "in", column: "id", values: [1, 2, 3] }, p)).toBe('"id" IN ($1, $2, $3)');
      expect(renderFilter({ kind: "in", column: "id", values: [] }, p)).toBe("false");
      expect(p.values).toEqual([1, 2, 3]);
    });

    it("renders .is() as a literal keyword, not a bound param", () => {
      const p = new ParamAccumulator();
      expect(renderFilter({ kind: "is", column: "deleted_at", value: null }, p)).toBe('"deleted_at" IS NULL');
      expect(renderFilter({ kind: "is", column: "active", value: true }, p)).toBe('"active" IS TRUE');
      expect(p.values).toEqual([]);
    });

    it("throws on an unsupported .is() value", () => {
      const p = new ParamAccumulator();
      const bad = { kind: "is", column: "x", value: 1 } as Filter;
      expect(() => renderFilter(bad, p)).toThrow(/only supports null\/true\/false/);
    });

    it("quotes the filter column (rejects an injected column)", () => {
      const p = new ParamAccumulator();
      expect(() => renderFilter({ kind: "eq", column: "x = 1 OR 1", value: 1 }, p)).toThrow(/unsafe identifier/);
    });
  });

  describe("joinParts", () => {
    it("drops empty fragments and single-spaces the rest", () => {
      expect(joinParts(["SELECT *", "", "FROM t", "  ", "LIMIT $1"])).toBe("SELECT * FROM t LIMIT $1");
    });
  });

  describe("toShimError", () => {
    it("maps a pg error to the PostgREST-ish shape, preserving SQLSTATE", () => {
      const e = toShimError({ code: "23505", message: "dup", detail: "Key exists", hint: "use upsert" });
      expect(e).toEqual({ code: "23505", message: "dup", details: "Key exists", hint: "use upsert" });
    });

    it("falls back to a generic message when none is present", () => {
      expect(toShimError({}).message).toBe("query failed");
    });
  });
});

describe("rangeNotSatisfiable", () => {
  it("says nothing when the total is unknown, which is PostgREST without an exact count", () => {
    expect(rangeNotSatisfiable(900, null)).toBeNull();
  });

  it("says nothing at the strict boundary offset === total", () => {
    expect(rangeNotSatisfiable(2, 2)).toBeNull();
  });

  it("carries both numbers in the details sentence, byte for byte", () => {
    expect(rangeNotSatisfiable(1, 0)).toEqual({
      code: "PGRST103",
      message: "Requested range not satisfiable",
      details: "An offset of 1 was requested, but there are only 0 rows.",
    });
  });
});

describe("renderInsertStatement", () => {
  it("refuses an empty batch before it can render invalid SQL", () => {
    expect(() => renderInsertStatement("t", [], "*", new ParamAccumulator())).toThrow(/at least one row/);
  });

  it("carries the PGRST102 code on the refusal so consumers can narrow on it", () => {
    try {
      renderInsertStatement("t", [{ a: 1 }, { a: 1, b: 2 }], "*", new ParamAccumulator());
      throw new Error("expected a refusal");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("PGRST102");
      expect((error as Error).message).toBe("All object keys must match");
    }
  });

  it("parameterizes every value and quotes every identifier", () => {
    const params = new ParamAccumulator();
    expect(renderInsertStatement("clients", [{ id: "c1", email: "a@b.test" }], "id", params))
      .toBe('INSERT INTO "clients" ("id", "email") VALUES ($1, $2) RETURNING "id"');
    expect(params.values).toEqual(["c1", "a@b.test"]);
  });
});
