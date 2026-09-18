import { describe, expect, it, vi } from "vitest";

import {
  createDunningFailureClassPort,
  failureClassFromRow,
} from "./dunningFailureClassPort.js";

const signal = new AbortController().signal;

function client(result: { data: unknown; error: unknown }) {
  const calls: Array<{ table: string; columns: string; column: string; value: unknown }> = [];
  const builder = {
    table: "",
    columns: "",
    column: "",
    value: undefined as unknown,
    select(columns: string) {
      this.columns = columns;
      return this;
    },
    eq(column: string, value: unknown) {
      this.column = column;
      this.value = value;
      return this;
    },
    async maybeSingle() {
      calls.push({ table: this.table, columns: this.columns, column: this.column, value: this.value });
      return result;
    },
  };
  return {
    calls,
    client: {
      from(table: string) {
        builder.table = table;
        return builder;
      },
    },
  };
}

describe("failureClassFromRow", () => {
  it("reads the class off the row", () => {
    expect(failureClassFromRow({ failure_class: "mandate_dead" })).toBe("mandate_dead");
    expect(failureClassFromRow({ failure_class: "  sca_required  " })).toBe("sca_required");
  });

  it("answers null for every shape that is not a class", () => {
    expect(failureClassFromRow(null)).toBeNull();
    expect(failureClassFromRow(undefined)).toBeNull();
    expect(failureClassFromRow([])).toBeNull();
    expect(failureClassFromRow("mandate_dead")).toBeNull();
    expect(failureClassFromRow({})).toBeNull();
    expect(failureClassFromRow({ failure_class: null })).toBeNull();
    expect(failureClassFromRow({ failure_class: 7 })).toBeNull();
    expect(failureClassFromRow({ failure_class: "   " })).toBeNull();
    expect(failureClassFromRow({ failure_class: "x".repeat(41) })).toBeNull();
  });

  it("passes through a class this deployment has never heard of", () => {
    // The column's CHECK is the guard. Re-validating here would be a second copy
    // of the class list; the unknown value resolves to the `unknown` cause and
    // renders nothing, which is the same outcome as rejecting it.
    expect(failureClassFromRow({ failure_class: "a_class_from_a_newer_deployment" })).toBe(
      "a_class_from_a_newer_deployment",
    );
  });
});

describe("createDunningFailureClassPort", () => {
  it("reads exactly one column of one case row", async () => {
    const { client: c, calls } = client({ data: { failure_class: "hard_do_not_retry" }, error: null });
    const port = createDunningFailureClassPort(c);

    expect(await port.resolve("case-1", signal)).toBe("hard_do_not_retry");
    expect(calls).toEqual([
      {
        table: "subscription_dunning_cases",
        columns: "failure_class",
        column: "id",
        value: "case-1",
      },
    ]);
  });

  it("degrades to null on a query error instead of failing the send", async () => {
    const { client: c } = client({ data: null, error: { message: "boom" } });
    expect(await createDunningFailureClassPort(c).resolve("case-1", signal)).toBeNull();
  });

  it("degrades to null on a missing case", async () => {
    const { client: c } = client({ data: null, error: null });
    expect(await createDunningFailureClassPort(c).resolve("case-1", signal)).toBeNull();
  });

  it("degrades to null when the client throws", async () => {
    const port = createDunningFailureClassPort({
      from: vi.fn(() => {
        throw new Error("connection reset");
      }) as never,
    });
    expect(await port.resolve("case-1", signal)).toBeNull();
  });
});
